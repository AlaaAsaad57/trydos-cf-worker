import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SERVICE_TOKENS } from "@cf/shared";

/** Handler tests that run inside workerd.
 *
 *  The point of running these in the real runtime rather than under Node is
 *  the URL parser. Every containment guard in this proxy is a statement about
 *  how `new URL(base + target)` resolves, and a Node/workerd difference there
 *  is a token-carrying SSRF, not a failing assertion. Unit tests cover the
 *  guard functions; these cover the handler that trusts them. */

const CORE = "https://core.test";
const GATEWAY = "https://gateway.test";

const proxyRequest = (
  overrides: {
    server?: string;
    url?: string;
    method?: string;
    cookie?: string;
    body?: BodyInit | null;
    contentType?: string;
    needDecode?: string;
  } = {},
) => {
  const headers = new Headers({
    "x-proxy-server": overrides.server ?? SERVICE_TOKENS.market,
    "x-proxy-url": overrides.url ?? "/orders/list",
    "x-proxy-method": overrides.method ?? "GET",
    "x-country": "sy",
    "x-language": "ar",
  });
  if (overrides.needDecode) headers.set("x-need-decode", overrides.needDecode);
  if (overrides.cookie) headers.set("Cookie", overrides.cookie);
  if (overrides.contentType) headers.set("content-type", overrides.contentType);

  return new Request("https://trydos.ramaaz.dev/api/proxy", {
    method: "POST",
    headers,
    body: overrides.body ?? null,
  });
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("method contract", () => {
  it("refuses anything that is not POST", async () => {
    const response = await SELF.fetch("https://trydos.ramaaz.dev/api/proxy", {
      method: "GET",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("service validation", () => {
  // An unknown service and a failing upstream must be indistinguishable, or
  // the pair becomes a way to discover which service names are real.
  it("answers an unknown service with the generic failure", async () => {
    const response = await SELF.fetch(proxyRequest({ server: "not-a-service" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Proxy request failed" });
  });

  it("answers an empty service with the same generic failure", async () => {
    const response = await SELF.fetch(proxyRequest({ server: "" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Proxy request failed" });
  });

  it("rejects a missing target url", async () => {
    const response = await SELF.fetch(proxyRequest({ url: "" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing target URL" });
  });
});

describe("SSRF containment", () => {
  it.each([
    ["a host rewrite via userinfo", "@evil.tld/x"],
    ["a protocol-relative target", "//evil.tld/x"],
    ["a backslash-escaped target", "/\\evil.tld/x"],
    ["an encoded protocol-relative target", "/%2F%2Fevil.tld/x"],
    ["a doubly-encoded protocol-relative target", "/%252F%252Fevil.tld/x"],
    ["path traversal out of the base", "/../../internal/admin"],
    ["a relative target", "orders/list"],
  ])("refuses %s without calling upstream", async (_label, url) => {
    // disableNetConnect + assertNoPendingInterceptors means any upstream call
    // here would fail the test rather than silently succeed.
    const response = await SELF.fetch(proxyRequest({ url }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid target URL" });
  });
});

describe("OTP relay block", () => {
  it.each([
    ["the plain path", "/auth/phone/send_otp"],
    ["a single-encoded path", "/auth/phone/send%5Fotp"],
    ["a double-encoded path", "/auth/phone/send%255Fotp"],
  ])("refuses %s", async (_label, url) => {
    const response = await SELF.fetch(proxyRequest({ url }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });
});

describe("forwarding", () => {
  it("injects the bearer token from the HttpOnly cookie", async () => {
    fetchMock
      .get(CORE)
      .intercept({
        path: "/api/v1/orders/list",
        method: "GET",
        headers: { Authorization: "Bearer market-jwt" },
      })
      .reply(200, { ok: true });

    const response = await SELF.fetch(
      proxyRequest({ cookie: "MARKET-TOKEN=market-jwt" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // The browser sends cookies to the proxy; the proxy must not pass them on.
  it("never forwards the cookie header upstream", async () => {
    let sawCookie: string | null = "unset";
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .reply(200, (opts) => {
        const headers = new Headers(opts.headers as HeadersInit);
        sawCookie = headers.get("cookie");
        return { ok: true };
      });

    await SELF.fetch(
      proxyRequest({ cookie: "MARKET-TOKEN=market-jwt; User-Data=x" }),
    );

    expect(sawCookie).toBeNull();
  });

  it("marks which market backend answered", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .reply(200, { ok: true });

    const response = await SELF.fetch(proxyRequest());
    expect(response.headers.get("x-market-backend")).toBe("core");
  });

  it("routes a guest on an allow-listed path to the gateway", async () => {
    fetchMock
      .get(GATEWAY)
      .intercept({ path: "/api/v1/cart/add", method: "POST" })
      .reply(200, { ok: true });

    const response = await SELF.fetch(
      proxyRequest({ url: "/cart/add", method: "POST" }),
    );
    expect(response.headers.get("x-market-backend")).toBe("gateway");
  });

  it("keeps a verified user on core even for an allow-listed path", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/cart/add", method: "POST" })
      .reply(200, { ok: true });

    const response = await SELF.fetch(
      proxyRequest({
        url: "/cart/add",
        method: "POST",
        cookie: `User-Data=${encodeURIComponent(JSON.stringify({ phone: "+963900000000" }))}`,
      }),
    );
    expect(response.headers.get("x-market-backend")).toBe("core");
  });

  it("never caches a proxied answer", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .reply(200, { ok: true });

    const response = await SELF.fetch(proxyRequest());
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes a 204 through with no body", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .reply(204, "");

    const response = await SELF.fetch(proxyRequest());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("surfaces an upstream error status rather than masking it", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .reply(401, { error: "unauthorized" });

    // A 401 must reach the client untouched — the client drives the refresh
    // flow off it (REFRESH-FLOWS.md Flow 2), and this proxy does not refresh.
    const response = await SELF.fetch(proxyRequest());
    expect(response.status).toBe(401);
  });

  it("collapses an upstream network failure into the generic failure", async () => {
    fetchMock
      .get(CORE)
      .intercept({ path: "/api/v1/orders/list", method: "GET" })
      .replyWithError(new Error("connection reset"));

    const response = await SELF.fetch(proxyRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Proxy request failed" });
  });
});

describe("env", () => {
  it("has the backend bases the routing needs", () => {
    expect(env.BACKEND_URL).toBe(`${CORE}/api/v1`);
    expect(env.GO_BACKEND_URL).toBe(`${GATEWAY}/api/v1`);
  });
});
