import { describe, expect, it } from "vitest";
import { HttpFamilySessionClient } from "@/adapters/http/http-family-session-client";

function clientAnswering(response: Response | (() => never)) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  const client = new HttpFamilySessionClient({
    fetchImplementation: async (input, init) => {
      calls.push({ input, init });
      if (typeof response === "function") {
        response();
      }
      return response as Response;
    },
  });

  return { client, calls };
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpFamilySessionClient", () => {
  it("posts the code to the sign-in endpoint as JSON", async () => {
    const { client, calls } = clientAnswering(jsonResponse(200, { authenticated: true }));

    await client.openSession("tal-der-lampen");

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/family/session");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ accessCode: "tal-der-lampen" });
  });

  it("reports a granted session for a successful answer", async () => {
    const { client } = clientAnswering(jsonResponse(200, { authenticated: true }));

    await expect(client.openSession("tal-der-lampen")).resolves.toBe("granted");
  });

  it("maps every refusal to its own outcome", async () => {
    const expected = [
      [400, "denied"],
      [401, "denied"],
      [429, "rate-limited"],
      [503, "unavailable"],
      [500, "transport"],
    ] as const;

    for (const [status, outcome] of expected) {
      const { client } = clientAnswering(jsonResponse(status, { authenticated: false }));
      await expect(client.openSession("x"), `status ${status}`).resolves.toBe(outcome);
    }
  });

  it("reports transport rather than a denial when the request never arrived", async () => {
    const { client } = clientAnswering(() => {
      throw new TypeError("network down");
    });

    // Telling a family "that code is wrong" for a request that never left the device
    // would send them looking for a problem that is not theirs.
    await expect(client.openSession("tal-der-lampen")).resolves.toBe("transport");
  });

  it("never throws, whatever the transport does", async () => {
    const { client } = clientAnswering(() => {
      throw new Error("boom");
    });

    await expect(client.openSession("x")).resolves.toBe("transport");
  });
});
