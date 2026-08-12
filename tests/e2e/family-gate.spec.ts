import { expect, test } from "@playwright/test";
import { focusQuestion } from "@/content/open-questions";
import { expectChildSafe } from "../support/child-safe";
import { signInAsFamily, signInThroughTheForm } from "../support/family-session";

/**
 * The gate as a child and a parent meet it. No beforeEach sign-in here on purpose:
 * these tests are about what an unsigned browser can and cannot do.
 */

const answerText = "Mein Tier ist ein kleiner Steinwolf.";

const validSubmission = {
  submissionId: "e2e-anonymous-attempt",
  questionId: "companion-animal",
  createdAt: "2026-08-12T00:00:00.000Z",
  originalText: answerText,
};

test("an unsigned browser is offered the family code instead of the answer field", async ({
  page,
}) => {
  await page.goto("/");

  // The world stays readable - only writing is gated.
  await expect(page.getByRole("heading", { level: 2, name: focusQuestion().title })).toBeVisible();

  await expect(page.getByLabel("Familien-Code")).toBeVisible();
  // Not merely disabled: there is no field inviting an answer this browser may not send.
  await expect(page.getByLabel("Deine Antwort")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Antwort speichern" })).toHaveCount(0);
});

test("the sign-in panel stays free of technical vocabulary", async ({ page }) => {
  await page.goto("/");

  const visibleText = await page.locator("body").innerText();
  // Guard against a locator that silently matches nothing: the gate copy has to be in
  // the text this assertion reads, otherwise the check below proves nothing.
  expect(visibleText).toContain("Familien-Code");

  expectChildSafe(visibleText, "the sign-in panel");
});

test("a wrong family code is refused in child-friendly words and opens nothing", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByLabel("Familien-Code").fill("das-ist-nicht-der-code");
  await page.getByRole("button", { name: "Weiter" }).click();

  const outcome = page.getByRole("status");
  await expect(outcome).toBeVisible();
  expectChildSafe(await outcome.innerText(), "the refused sign-in message");

  await expect(page.getByLabel("Deine Antwort")).toHaveCount(0);
});

test("the right family code opens the answer form and an answer arrives", async ({ page }) => {
  await page.goto("/");
  await signInThroughTheForm(page);

  const answerField = page.getByLabel("Deine Antwort");
  await expect(answerField).toBeVisible();
  await expect(page.getByLabel("Familien-Code")).toHaveCount(0);

  await answerField.fill(answerText);
  await page.getByRole("button", { name: "Antwort speichern" }).click();

  await expect(
    page.getByRole("region", { name: "Das hast du schon geschickt." }).getByText(
      "Im Projekt angekommen",
    ),
  ).toBeVisible();
});

test("the inbox refuses an anonymous submission", async ({ request }) => {
  // The `request` fixture is its own context with its own empty cookie jar, so this is
  // genuinely a caller that never signed in.
  const response = await request.post("/api/inbox/submissions", { data: validSubmission });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({
    acknowledged: false,
    error: "unauthorized",
  });
});

test("the inbox refuses a forged session cookie", async ({ request }) => {
  const response = await request.post("/api/inbox/submissions", {
    headers: { cookie: "avaloria_family_session=v1.9999999999.nonce.forged-signature" },
    data: validSubmission,
  });

  expect(response.status()).toBe(401);
});

test("the sign-in endpoint refuses a wrong code and hands out no cookie", async ({ request }) => {
  const response = await request.post("/api/family/session", {
    data: { accessCode: "das-ist-nicht-der-code" },
  });

  expect(response.status()).toBe(401);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("a signed-in browser reaches the inbox and a repeat delivery stays one submission", async ({
  page,
}) => {
  await signInAsFamily(page);

  const submission = { ...validSubmission, submissionId: "e2e-idempotent-delivery" };

  const first = await page.request.post("/api/inbox/submissions", { data: submission });
  expect(first.status()).toBe(201);
  const firstBody = (await first.json()) as { receiptId: string; receivedAt: string };

  const retry = await page.request.post("/api/inbox/submissions", { data: submission });

  // 200 rather than 201, and the receipt the submission already had.
  expect(retry.status()).toBe(200);
  await expect(retry.json()).resolves.toEqual({
    acknowledged: true,
    receiptId: firstBody.receiptId,
    receivedAt: firstBody.receivedAt,
  });
});

test("the session cookie cannot be read by page scripts", async ({ page }) => {
  await signInAsFamily(page);
  await page.goto("/");

  // HttpOnly, proven from where an injected script would sit rather than from the
  // Set-Cookie header the server sent.
  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain("avaloria_family_session");

  // And the session really is present in the jar the browser will not show scripts.
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "avaloria_family_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
});
