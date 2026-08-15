import { expect, test } from "@playwright/test";
import { TEST_ADMIN_ACCESS_CODE } from "../support/admin-access-code";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { signInAsAdmin, signInThroughTheAdminForm } from "../support/admin-session";
import { signInAsFamily } from "../support/family-session";

const ADMIN_INBOX = "/api/admin/inbox/submissions";

/** Synthetic throughout: no real child, no real name, no production text. */
const answerText = "  Ein Steinwolf mit zwei Laternen.  ";

async function submitOneAnswer(
  page: import("@playwright/test").Page,
  submissionId: string,
  questionId = "companion-animal",
): Promise<void> {
  const response = await page.request.post("/api/inbox/submissions", {
    data: {
      submissionId,
      questionId,
      createdAt: "2026-08-14T00:00:00.000Z",
      originalText: answerText,
    },
  });
  expect([200, 201]).toContain(response.status());
}

test("an anonymous browser is offered the admin code and no submission data", async ({ page }) => {
  await page.goto("/admin");

  await expect(page.getByLabel("Projekt-Zugangscode")).toBeVisible();
  // Not merely hidden: the filters and the list are not on the page at all.
  await expect(page.getByRole("region", { name: "Eingegangene Antworten" })).toHaveCount(0);
  await expect(page.getByLabel("Status")).toHaveCount(0);

  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Originaltext");
});

test("the admin inbox refuses an anonymous request and returns no entries", async ({ request }) => {
  // The `request` fixture has its own empty cookie jar: a caller that never signed in.
  const response = await request.get(ADMIN_INBOX);

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" });

  const raw = await response.text();
  expect(raw).not.toContain("originalText");
  expect(raw).not.toContain(TEST_ADMIN_ACCESS_CODE);
});

test("a FAMILY session opens nothing in the admin inbox", async ({ page }) => {
  // The core separation. A child holds the family code; it must buy no read access.
  await signInAsFamily(page);

  const response = await page.request.get(ADMIN_INBOX);
  expect(response.status()).toBe(401);

  await page.goto("/admin");
  await expect(page.getByLabel("Projekt-Zugangscode")).toBeVisible();
  await expect(page.getByRole("region", { name: "Eingegangene Antworten" })).toHaveCount(0);
});

test("the family access code is refused by the admin sign-in endpoint", async ({ request }) => {
  const response = await request.post("/api/admin/session", {
    data: { accessCode: TEST_FAMILY_ACCESS_CODE },
  });

  expect(response.status()).toBe(401);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("a wrong admin code is refused and hands out no cookie", async ({ page, request }) => {
  const response = await request.post("/api/admin/session", {
    data: { accessCode: "das-ist-nicht-der-code" },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["set-cookie"]).toBeUndefined();

  await page.goto("/admin");
  await page.getByLabel("Projekt-Zugangscode").fill("das-ist-nicht-der-code");
  await page.getByRole("button", { name: "Anmelden" }).click();

  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("region", { name: "Eingegangene Antworten" })).toHaveCount(0);
});

test("the admin session cookie cannot be read by page scripts", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/admin");

  // HttpOnly, proven from where an injected script would sit rather than from the
  // Set-Cookie header the server sent.
  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain("avaloria_admin_session");

  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "avaloria_admin_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
});

test("a signed-in adult reads a submitted answer with its original text unchanged", async ({
  page,
}) => {
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-admin-read-1");
  await signInAsAdmin(page);

  await page.goto("/admin");

  // Scoped to ONE card, not to the first of each kind on the page: the suite runs
  // fullyParallel against a shared inbox, so "the first Systemangaben" and "the
  // Originaltext holding Steinwolf" can belong to different entries and the separation
  // assertions below would then be about two unrelated cards.
  const entry = page.locator(".admin-entry").filter({ hasText: "e2e-admin-read-1" });
  await expect(entry).toHaveCount(1);

  const original = entry.getByRole("region", { name: "Originaltext" });
  await expect(original).toBeVisible();
  // The stored text byte for byte, including the padding the child typed. `innerText`
  // would collapse it; textContent does not.
  expect(await original.locator(".admin-original-text").textContent()).toBe(answerText);

  // Original and derived live in separate labelled regions - the acceptance criterion
  // is about the separation, so it is asserted rather than eyeballed.
  const derived = entry.getByRole("region", { name: "Systemangaben" });
  await expect(derived).toBeVisible();
  await expect(derived).toContainText("RECEIVED");
  await expect(derived).toContainText("companion-animal");
  await expect(derived).toContainText("text");
  // The child's words are NOT repeated in the system block.
  await expect(derived).not.toContainText("Steinwolf");
});

test("the sign-in panel opens the inbox when the right code is typed", async ({ page }) => {
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-admin-form-signin");

  await page.context().clearCookies();
  await page.goto("/admin");
  await signInThroughTheAdminForm(page);

  await expect(page.getByRole("region", { name: "Eingegangene Antworten" })).toBeVisible();
  await expect(page.getByLabel("Projekt-Zugangscode")).toHaveCount(0);
});

test("filtering by question narrows the list, and resetting widens it again", async ({ page }) => {
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-filter-companion", "companion-animal");
  await submitOneAnswer(page, "e2e-filter-door", "hidden-door");
  await signInAsAdmin(page);

  await page.goto("/admin");
  const entries = page.locator(".admin-entry");
  await expect(entries.filter({ hasText: "companion-animal" })).not.toHaveCount(0);
  await expect(entries.filter({ hasText: "hidden-door" })).not.toHaveCount(0);

  await page.getByLabel("Frage").fill("hidden-door");

  await expect(entries.filter({ hasText: "companion-animal" })).toHaveCount(0);
  await expect(entries.filter({ hasText: "hidden-door" })).not.toHaveCount(0);

  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  await expect(entries.filter({ hasText: "companion-animal" })).not.toHaveCount(0);
});

test("filtering by status and by kind keeps the entries visible", async ({ page }) => {
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-filter-status");
  await signInAsAdmin(page);

  await page.goto("/admin");

  await page.getByLabel("Status").selectOption("RECEIVED");
  await expect(page.locator(".admin-entry").first()).toBeVisible();

  await page.getByLabel("Art").selectOption("text");
  await expect(page.locator(".admin-entry").first()).toBeVisible();
});

test("an unknown filter value is refused with a code and no stack trace", async ({ page }) => {
  await signInAsAdmin(page);

  const response = await page.request.get(`${ADMIN_INBOX}?status=PROCESSED`);

  // Refused, not silently ignored: answering with everything would tell the caller
  // something false about what they are looking at.
  expect(response.status()).toBe(400);
  const raw = await response.text();
  expect(JSON.parse(raw)).toEqual({ error: "invalid-query" });
  expect(raw).not.toMatch(/at Object|at async|node:|Error:/u);
});

test("the admin inbox exposes no way to change a submission", async ({ page }) => {
  await signInAsAdmin(page);

  for (const method of ["post", "put", "patch", "delete"] as const) {
    const response = await page.request[method](ADMIN_INBOX, { failOnStatusCode: false });
    expect(
      response.status(),
      `${method.toUpperCase()} must not be handled by the admin inbox route`,
    ).toBe(405);
  }
});

test("the child path is untouched by the admin surface", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/");

  // An admin session is not a family session: the child page still asks for the family
  // code, and the write path still refuses.
  await expect(page.getByLabel("Familien-Code")).toBeVisible();

  const write = await page.request.post("/api/inbox/submissions", {
    data: {
      submissionId: "e2e-admin-cannot-write",
      questionId: "companion-animal",
      createdAt: "2026-08-14T00:00:00.000Z",
      originalText: "darf nicht durchkommen",
    },
  });
  expect(write.status()).toBe(401);
});

/*
 * The cases below exist because the two admin components have ZERO unit coverage - this
 * repo has no React testing library - so nothing about their rendered behaviour is
 * established anywhere else. Each one pins a specific claim that was until now only
 * reasoned about.
 */

test("resetting without having changed a filter leaves the list visible", async ({ page }) => {
  // A real bug that was written and self-caught during implementation, and whose fix has
  // never been executed: the reset button used to pass the stable EMPTY_FILTERS module
  // constant, which is also the initial state. Clicking reset without having touched a
  // filter therefore handed useState the reference it already held, React kept the state
  // identical, the read effect - keyed on that reference - never re-ran, and the view sat
  // behind "Wird geladen …" forever with no request in flight. Reasoning alone cannot
  // tell whether the fresh-object fix actually clears it; this click can.
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-reset-untouched");
  await signInAsAdmin(page);

  await page.goto("/admin");
  await expect(page.locator(".admin-entry").first()).toBeVisible();

  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();

  // The wedge would show up exactly here: an entry that never comes back, and a loading
  // line that never leaves.
  await expect(page.locator(".admin-entry").first()).toBeVisible();
  await expect(page.getByText("Wird geladen …")).toHaveCount(0);
});

test("typing a question id costs one read rather than one per keystroke", async ({ page }) => {
  // QUESTION_FILTER_DEBOUNCE_MS exists because an adult typing a 16-character question id
  // would otherwise issue 16 reads against a route whose production ceiling is 60/min and
  // rate-limit themselves out of their own inbox. That the debounce actually collapses
  // keystrokes is a claim about the committed component, so it is counted here.
  // pressSequentially, not fill: fill is one input event and would prove nothing.
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-debounce-read");
  await signInAsAdmin(page);

  const typed = "companion-animal";
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes(ADMIN_INBOX)) reads += 1;
  });

  await page.goto("/admin");
  await expect(page.locator(".admin-entry").first()).toBeVisible();

  // Counted from here, so the unavoidable first read on mount is not attributed to typing.
  const readsBeforeTyping = reads;

  // Waited for explicitly, and set up before the first keystroke. Merely asserting that
  // an entry is visible afterwards proves nothing: the previous list is still on screen
  // during the whole debounce window, so the assertion passes before the committed read
  // has been issued and the counter reads zero. Measured: it did.
  const committedRead = page.waitForRequest(
    (request) =>
      request.url().includes(ADMIN_INBOX) && request.url().includes(`questionId=${typed}`),
  );
  await page.getByLabel("Frage").pressSequentially(typed, { delay: 10 });
  await committedRead;

  const readsFromTyping = reads - readsBeforeTyping;

  // Guard against a vacuous pass: the keystrokes really did happen.
  expect(await page.getByLabel("Frage").inputValue()).toBe(typed);
  expect(typed.length).toBe(16);
  // One commit is the intent; the ceiling is loose enough to survive a slow machine that
  // stretches the typing past one debounce window, and still an order of magnitude below
  // one read per character.
  expect(readsFromTyping).toBeGreaterThan(0);
  expect(readsFromTyping).toBeLessThanOrEqual(3);
});

test("rapid filter changes settle on the last value typed, not an earlier one", async ({ page }) => {
  // The view holds a createLatestOnly sequence so a read that has been superseded may not
  // paint. Never executed until now. What an adult can actually observe is the settled
  // state, so that is what is asserted: after three filter changes in quick succession the
  // list must answer the LAST one.
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-latest-companion", "companion-animal");
  await submitOneAnswer(page, "e2e-latest-door", "hidden-door");
  await signInAsAdmin(page);

  await page.goto("/admin");
  const entries = page.locator(".admin-entry");
  await expect(entries.first()).toBeVisible();

  const question = page.getByLabel("Frage");
  await question.fill("companion-animal");
  await question.fill("gibt-es-nicht");
  await question.fill("hidden-door");

  await expect(entries.filter({ hasText: "hidden-door" })).not.toHaveCount(0);
  // And none of the superseded queries left its answer on screen.
  await expect(entries.filter({ hasText: "companion-animal" })).toHaveCount(0);
  await expect(page.getByText("Keine Antworten für diese Auswahl.")).toHaveCount(0);
});

test("the admin code field neither shows the code nor offers it to autofill", async ({ page }) => {
  // Two DOM attributes, both unproven until now, both cheap to lose in a refactor. The
  // code is typed by an adult on a shared family machine, often with a child in the room.
  await page.goto("/admin");

  const field = page.getByLabel("Projekt-Zugangscode");
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
});

test("the sign-in button stays disabled until a code is typed", async ({ page }) => {
  // An empty submit would spend one of the sign-in route's rate-limited attempts on a
  // request that cannot succeed, so the button refuses to offer it.
  await page.goto("/admin");

  const submit = page.getByRole("button", { name: "Anmelden" });
  await expect(submit).toBeDisabled();

  await page.getByLabel("Projekt-Zugangscode").fill("x");
  await expect(submit).toBeEnabled();
});

test("an expired admin session returns the adult to the sign-in panel", async ({ page }) => {
  // The most-travelled failure path in this feature: session expiry is how every admin
  // session normally ends. The view reports "Die Anmeldung gilt nicht mehr. Bitte neu
  // anmelden." - and until the read side asked the server to re-render, there was nothing
  // on screen to sign in with. The signed-in/signed-out choice is made in the server
  // component, so only a refresh can change it; an adult had to independently know to
  // reload. This case fails without that refresh.
  await signInAsFamily(page);
  await submitOneAnswer(page, "e2e-admin-session-expired");
  await signInAsAdmin(page);

  await page.goto("/admin");
  await expect(page.locator(".admin-entry").first()).toBeVisible();

  // Drop the admin cookie from under the open page, leaving the family one alone: the
  // browser now holds exactly what an adult holds after the session lapsed, while the
  // already-rendered view still believes it may read.
  const surviving = (await page.context().cookies()).filter(
    (cookie) => cookie.name !== "avaloria_admin_session",
  );
  await page.context().clearCookies();
  await page.context().addCookies(surviving);

  // Any re-read now answers 401. Moving a filter is how an adult would discover it.
  await page.getByLabel("Status").selectOption("RECEIVED");

  await expect(page.getByLabel("Projekt-Zugangscode")).toBeVisible();
  await expect(page.getByRole("region", { name: "Eingegangene Antworten" })).toHaveCount(0);
});

test("a failed read leaves exactly one live region speaking", async ({ page }) => {
  // Two `role="status"` elements used to render together on failure - the message, plus a
  // second, empty one where the loading line would go. An empty live region announces
  // nothing, so the cost is a screen reader hearing two regions update in one tick. It is
  // also a test hazard: getByRole("status") is a strict locator, so a second match throws
  // a strict-mode violation instead of failing usefully.
  await signInAsAdmin(page);
  await page.goto("/admin");

  const inbox = page.getByRole("region", { name: "Eingegangene Antworten" });
  await expect(inbox).toBeVisible();

  // A questionId the route refuses outright: over its 200-character ceiling, so the answer
  // is 400 invalid-query and the view takes its failure branch.
  await page.getByLabel("Frage").fill("z".repeat(201));

  await expect(inbox.getByText("Diese Filterkombination ist nicht gültig. Bitte die Auswahl ändern.")).toBeVisible();
  // The assertion: one region, not two. Counted rather than asserted through a strict
  // locator, so a regression reports a number instead of throwing.
  await expect(inbox.locator('[role="status"]')).toHaveCount(1);
});
