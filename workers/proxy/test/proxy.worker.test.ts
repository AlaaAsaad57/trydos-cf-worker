import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SERVICE_TOKENS } from "@cf/shared";

/** Handler tests that run inside workerd.
 *
 *  The point of the real runtime rather than Node is the URL parser. Every
 *  containment guard in this proxy is a statement about how
 *  `new URL(base + target)` resolves, and a Node/workerd difference there is a
 *  token-carrying SSRF, not a failing assertion. The unit tests cover the
 *  guard functions; these cover the handler that trusts them.
 *
 *  Upstream is intercepted by the outbound service in vitest.config.ts, which
 *  echoes what it received. `fetchMock` was removed in vitest-pool-workers
 *  0.22 — do not reintroduce it. */

// Mirrors the bindings in vitest.config.ts. Kept as literals rather than read
// from `env` so the tests do not depend on ambient binding types.
const CORE = "https://core.test/api/v1";
const GATEWAY = "https://gateway.test/api/v1";
const WALLET = "https://wallet.test";

interface Echo {
  seenUrl: string;
  seenMethod: string;
  seenAuth: string | null;
  seenCookie: string | null;
  seenCountryCode: string | null;
  seenRole: string | null;
}

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

const verifiedCookie = `User-Data=${encodeURIComponent(
  JSON.stringify({ phone: "+963900000000" }),
)}`;

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

// These reject before any upstream call, which is the whole point of them.
describe("SSRF containment", () => {
  it.each([
    ["a host rewrite via userinfo", "@evil.tld/x"],
    ["a protocol-relative target", "//evil.tld/x"],
    ["a backslash-escaped target", "/\\evil.tld/x"],
    ["an encoded protocol-relative target", "/%2F%2Fevil.tld/x"],
    ["a doubly-encoded protocol-relative target", "/%252F%252Fevil.tld/x"],
    ["path traversal out of the base", "/../../internal/admin"],
    ["a relative target", "orders/list"],
    ["an absolute url", "https://evil.tld/x"],
  ])("refuses %s", async (_label, url) => {
    const response = await SELF.fetch(proxyRequest({ url }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid target URL" });
  });

  it("still refuses a host rewrite when x-need-decode is set", async () => {
    const response = await SELF.fetch(
      proxyRequest({ url: "/%2F%2Fevil.tld/x", needDecode: "true" }),
    );
    expect(response.status).toBe(400);
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
    const response = await SELF.fetch(
      proxyRequest({ cookie: "MARKET-TOKEN=market-jwt" }),
    );
    const echo = (await response.json()) as Echo;

    expect(response.status).toBe(200);
    expect(echo.seenAuth).toBe("Bearer market-jwt");
  });

  // The browser sends cookies to the proxy; the proxy must not pass them on.
  it("never forwards the cookie header upstream", async () => {
    const response = await SELF.fetch(
      proxyRequest({ cookie: `MARKET-TOKEN=market-jwt; ${verifiedCookie}` }),
    );
    const echo = (await response.json()) as Echo;

    expect(echo.seenCookie).toBeNull();
  });

  it("sends no Authorization at all when there is no cookie", async () => {
    const response = await SELF.fetch(proxyRequest());
    const echo = (await response.json()) as Echo;

    expect(echo.seenAuth).toBeNull();
  });

  it("forwards the method named in x-proxy-method, not POST", async () => {
    const response = await SELF.fetch(
      proxyRequest({ url: "/cart/add", method: "PUT" }),
    );
    const echo = (await response.json()) as Echo;

    expect(echo.seenMethod).toBe("PUT");
  });

  it("upper-cases the country for the backends", async () => {
    const response = await SELF.fetch(proxyRequest());
    const echo = (await response.json()) as Echo;

    expect(echo.seenCountryCode).toBe("SY");
  });

  it("defaults the role to -1 without a USER-CHAT cookie", async () => {
    const response = await SELF.fetch(proxyRequest());
    const echo = (await response.json()) as Echo;

    expect(echo.seenRole).toBe("-1");
  });
});

describe("market backend routing", () => {
  it("sends a guest on an allow-listed path to the gateway", async () => {
    const response = await SELF.fetch(
      proxyRequest({ url: "/cart/add", method: "POST" }),
    );
    const echo = (await response.json()) as Echo;

    expect(echo.seenUrl).toBe(`${GATEWAY}/cart/add`);
    expect(response.headers.get("x-market-backend")).toBe("gateway");
  });

  it("sends a guest on a non-listed path to core", async () => {
    const response = await SELF.fetch(proxyRequest({ url: "/orders/list" }));
    const echo = (await response.json()) as Echo;

    expect(echo.seenUrl).toBe(`${CORE}/orders/list`);
    expect(response.headers.get("x-market-backend")).toBe("core");
  });

  // The rule that makes verified users bypass the allow-list entirely.
  it("keeps a verified user on core even for an allow-listed path", async () => {
    const response = await SELF.fetch(
      proxyRequest({ url: "/cart/add", method: "POST", cookie: verifiedCookie }),
    );
    const echo = (await response.json()) as Echo;

    expect(echo.seenUrl).toBe(`${CORE}/cart/add`);
    expect(response.headers.get("x-market-backend")).toBe("core");
  });

  it("routes a non-market service to its own backend", async () => {
    const response = await SELF.fetch(
      proxyRequest({ server: SERVICE_TOKENS.wallet, url: "/balance" }),
    );
    const echo = (await response.json()) as Echo;

    expect(echo.seenUrl).toBe(`${WALLET}/balance`);
    // The dashboard/market marker is market-only.
    expect(response.headers.get("x-market-backend")).toBeNull();
  });
});

describe("response handling", () => {
  it("never caches a proxied answer", async () => {
    const response = await SELF.fetch(proxyRequest());
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes a 204 through with no body", async () => {
    const response = await SELF.fetch(proxyRequest({ url: "/orders/__204" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  // A 401 must reach the client untouched — the client drives the refresh
  // flow off it (REFRESH-FLOWS.md Flow 2); this proxy does not refresh.
  it("surfaces an upstream 401 rather than masking it", async () => {
    const response = await SELF.fetch(proxyRequest({ url: "/orders/__401" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  // An upstream 5xx is a real answer and is forwarded as one — the original
  // route.ts only produces its own 503 when `fetch` itself rejects.
  //
  // Note this does NOT exercise that rejection path: a throwing outbound
  // service surfaces to the Worker as a 500 response, not a failed fetch, so
  // the handler's catch block stays unreached here. Simulating a genuine
  // connection failure would need an outbound target that is not intercepted
  // at all, which this pool does not offer. The catch block is therefore
  // covered by inspection only.
  it("passes an upstream 5xx through rather than rewriting it", async () => {
    const response = await SELF.fetch(proxyRequest({ url: "/orders/__boom" }));
    expect(response.status).toBe(500);
  });
});
