import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INGEST_ASSETS_HOST, INGEST_EVENTS_HOST } from "@cf/shared";
import { proxyIngest } from "../src/index";

/** Handler tests that run inside workerd.
 *
 *  The unit tests in packages/shared cover the pure routing and header rules.
 *  These cover the handler that trusts them, in the runtime that actually
 *  serves it — request/response body streaming and header mutability are the
 *  parts where Node and workerd differ, and both matter here.
 *
 *  Upstream PostHog is intercepted by the outbound service in vitest.config.ts,
 *  which echoes what it received. `fetchMock` was removed in
 *  vitest-pool-workers 0.22 — do not reintroduce it. */

const ORIGIN = "https://trydos.ramaaz.dev";

interface Echo {
  seenUrl: string;
  seenMethod: string;
  seenHeaders: Record<string, string>;
  seenBody: string | null;
}

const capture = (
  path = "/ingest/i/v0/e/",
  init: RequestInit = {},
): Promise<Response> => SELF.fetch(`${ORIGIN}${path}`, { method: "POST", ...init });

describe("ingest worker", () => {
  it("forwards a capture POST to the ingestion host with its body intact", async () => {
    const res = await capture("/ingest/i/v0/e/?compression=gzip-js", {
      method: "POST",
      body: '{"event":"$pageview"}',
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as Echo;
    expect(echo.seenUrl).toBe(`${INGEST_EVENTS_HOST}/i/v0/e/?compression=gzip-js`);
    expect(echo.seenMethod).toBe("POST");
    expect(echo.seenBody).toBe('{"event":"$pageview"}');
    expect(echo.seenHeaders["content-type"]).toBe("application/json");
  });

  it("never sends our first-party cookies to PostHog", async () => {
    // The reason this proxy exists. A logged-in shopper's cookie jar clears
    // ~8 KB and PostHog answers 400 — see packages/shared/src/ingest.ts.
    const res = await capture("/ingest/i/v0/e/", {
      method: "POST",
      body: "{}",
      headers: {
        cookie: `MARKET-TOKEN=secret; USER_ID_HASH=${"a".repeat(128)}`,
      },
    });
    const echo = (await res.json()) as Echo;
    expect(echo.seenHeaders["cookie"]).toBeUndefined();
  });

  it("sends /static/* to the assets host", async () => {
    const res = await SELF.fetch(`${ORIGIN}/ingest/static/array.js`);
    const echo = (await res.json()) as Echo;
    expect(echo.seenUrl).toBe(`${INGEST_ASSETS_HOST}/static/array.js`);
  });

  it("forwards the shadow route to the identical upstream URL", async () => {
    const shadow = (await (
      await SELF.fetch(`${ORIGIN}/ingest-edge/static/array.js`)
    ).json()) as Echo;
    const live = (await (
      await SELF.fetch(`${ORIGIN}/ingest/static/array.js`)
    ).json()) as Echo;
    expect(shadow.seenUrl).toBe(live.seenUrl);
  });

  it("passes the real client IP to PostHog as X-Forwarded-For", async () => {
    const res = await capture("/ingest/i/v0/e/", {
      method: "POST",
      body: "{}",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    const echo = (await res.json()) as Echo;
    expect(echo.seenHeaders["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("strips Set-Cookie from the upstream response", async () => {
    const res = await SELF.fetch(`${ORIGIN}/ingest/__cookie`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the upstream cache-control so assets stay cheap", async () => {
    const res = await SELF.fetch(`${ORIGIN}/ingest/__cookie`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=14400");
  });

  it("forwards OPTIONS rather than answering the preflight itself", async () => {
    const res = await SELF.fetch(`${ORIGIN}/ingest/i/v0/e/`, { method: "OPTIONS" });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as Echo;
    expect(echo.seenMethod).toBe("OPTIONS");
  });

  it("refuses methods the PostHog SDK never sends", async () => {
    const res = await SELF.fetch(`${ORIGIN}/ingest/i/v0/e/`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
  });

  it("404s a path outside the ingest prefix", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/proxy`);
    expect(res.status).toBe(404);
  });

  it("passes an upstream 5xx through so the SDK can retry", async () => {
    // PostHog failing is PostHog's problem to report; swallowing it here would
    // hide an outage behind a synthetic success.
    const res = await capture("/ingest/__boom", { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
  });

  it("fails silently when PostHog is unreachable", async () => {
    // route.ts:72 — analytics must never throw into the app. The outbound
    // service cannot simulate a network-level failure (a throw there becomes a
    // 500 *response*), so the fetcher is injected for this one case.
    const res = await proxyIngest(
      new Request(`${ORIGIN}/ingest/i/v0/e/`, { method: "POST", body: "{}" }),
      () => Promise.reject(new Error("connection reset")),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("");
  });

  describe("x-trydos-edge marker header", () => {
    // CLAUDE.md §3.14 says the only way to tell a Worker answered is that
    // `x-vercel-id` is *absent* — indirect, and easy to misread as "the
    // request failed" rather than "a different origin served it". This
    // header is a direct, positive marker instead. It must be on every
    // response shape the handler can return, not just the happy path.

    it("is present on the proxied 200 response", async () => {
      const res = await capture("/ingest/i/v0/e/", {
        method: "POST",
        body: "{}",
      });
      expect(res.headers.get("x-trydos-edge")).toBe("ingest");
    });

    it("is present on the 405 method-rejection response", async () => {
      const res = await SELF.fetch(`${ORIGIN}/ingest/i/v0/e/`, { method: "PUT" });
      expect(res.status).toBe(405);
      expect(res.headers.get("x-trydos-edge")).toBe("ingest");
    });

    it("is present on the 404 unknown-target response", async () => {
      const res = await SELF.fetch(`${ORIGIN}/api/proxy`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-trydos-edge")).toBe("ingest");
    });

    it("is present on the 502 upstream-failure response", async () => {
      const res = await proxyIngest(
        new Request(`${ORIGIN}/ingest/i/v0/e/`, { method: "POST", body: "{}" }),
        () => Promise.reject(new Error("connection reset")),
      );
      expect(res.status).toBe(502);
      expect(res.headers.get("x-trydos-edge")).toBe("ingest");
    });
  });

});
