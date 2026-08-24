import { describe, expect, it } from "vitest";
import { parseCookies } from "./cookies";
import {
  buildProxyHeaders,
  hasValidPhone,
  isGatewayApi,
  isVerifiedMarketUser,
  resolveBaseUrl,
  tokenForServer,
  type BackendEnv,
} from "./routing";
import { COOKIE_NAMES, fromServiceToken, isAllowedServer } from "./services";

const ENV: BackendEnv = {
  BACKEND_URL: "https://core.test/api/v1",
  GO_BACKEND_URL: "https://gateway.test/api/v1",
  ELASTIC_BACKEND_URL: "https://elastic.test",
  NEXT_PUBLIC_CHAT_BACKEND_URL: "https://chat.test",
  STORIES_BACKEND_URL: "https://stories.test",
  COMMENT_BACKEND_URL: "https://comments.test",
  WALLET_BACKEND_URL: "https://wallet.test",
};

const jarWith = (pairs: Record<string, string>) =>
  parseCookies(
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  );

const userData = (phone: unknown) =>
  encodeURIComponent(JSON.stringify({ phone }));

describe("service tokens", () => {
  it("maps an opaque wire token back to a service name", () => {
    expect(fromServiceToken("vv7qsd")).toBe("market");
    expect(fromServiceToken("ge8zpm")).toBe("wallet");
  });

  it("returns empty string for an unknown token", () => {
    expect(fromServiceToken("nope")).toBe("");
    expect(fromServiceToken("")).toBe("");
  });

  it("rejects an unknown service in the allowlist", () => {
    expect(isAllowedServer("market")).toBe(true);
    expect(isAllowedServer("")).toBe(false);
    expect(isAllowedServer("admin")).toBe(false);
  });
});

describe("isGatewayApi", () => {
  it("matches an exact allow-listed endpoint", () => {
    expect(isGatewayApi("/cart/add")).toBe(true);
    expect(isGatewayApi("/customer/info")).toBe(true);
  });

  it("matches by suffix, so a versioned prefix still routes", () => {
    expect(isGatewayApi("/shop/cart/add")).toBe(true);
  });

  it("ignores the query string when matching", () => {
    expect(isGatewayApi("/cart/add?utm=x")).toBe(true);
  });

  it("matches a dynamic-segment endpoint by its prefix", () => {
    expect(isGatewayApi("/web/product/globalDetails/some-slug")).toBe(true);
  });

  it("does not match an unrelated endpoint", () => {
    expect(isGatewayApi("/orders/list")).toBe(false);
    expect(isGatewayApi("/web/product/globalDetails")).toBe(false);
  });

  // Quirk 1, preserved from the original: the /checklist test runs on the raw
  // url, before the query string is stripped. It is a startsWith, so this is
  // asymmetric rather than wrong.
  it("matches /checklist from the start of the path", () => {
    expect(isGatewayApi("/checklist")).toBe(true);
    expect(isGatewayApi("/checklist/anything?x=1")).toBe(true);
  });
});

describe("hasValidPhone", () => {
  it.each([
    ["a real number", "+963900000000", true],
    ["a numeric phone", 963900000000, true],
    ["the string zero", "0", false],
    ["numeric zero", 0, false],
    ["empty", "", false],
    ["whitespace only", "   ", false],
    ["null", null, false],
    ["absent", undefined, false],
  ])("treats %s as %s", (_label, phone, expected) => {
    expect(hasValidPhone({ phone })).toBe(expected);
  });

  it("treats a missing profile as unverified", () => {
    expect(hasValidPhone(null)).toBe(false);
  });
});

describe("isVerifiedMarketUser", () => {
  it("reads verification from the User-Data cookie", () => {
    const jar = jarWith({ [COOKIE_NAMES.USER_DATA]: userData("+963900000000") });
    expect(isVerifiedMarketUser(jar)).toBe(true);
  });

  it("fails open to guest when the cookie is absent", () => {
    expect(isVerifiedMarketUser(parseCookies("lang=en"))).toBe(false);
  });

  it("fails open to guest when the cookie is not JSON", () => {
    expect(isVerifiedMarketUser(jarWith({ "User-Data": "garbage" }))).toBe(false);
  });
});

describe("resolveBaseUrl", () => {
  const guest = parseCookies("lang=en");
  const verified = jarWith({
    [COOKIE_NAMES.USER_DATA]: userData("+963900000000"),
  });

  it("sends a guest on an allow-listed path to the gateway", () => {
    expect(resolveBaseUrl("market", "/cart/add", ENV, guest)).toBe(
      ENV.GO_BACKEND_URL,
    );
  });

  it("sends a guest on a non-listed path to core", () => {
    expect(resolveBaseUrl("market", "/orders/list", ENV, guest)).toBe(
      ENV.BACKEND_URL,
    );
  });

  // The rule that makes verified users bypass the allow-list entirely.
  it("sends a verified user to core even on an allow-listed path", () => {
    expect(resolveBaseUrl("market", "/cart/add", ENV, verified)).toBe(
      ENV.BACKEND_URL,
    );
  });

  // market-dashboard routes by URL alone — the user check is market-only.
  it("routes the dashboard by url regardless of verification", () => {
    expect(resolveBaseUrl("market-dashboard", "/cart/add", ENV, verified)).toBe(
      ENV.GO_BACKEND_URL,
    );
    expect(resolveBaseUrl("market-dashboard", "/orders/list", ENV, guest)).toBe(
      ENV.BACKEND_URL,
    );
  });

  it.each([
    ["elastic", "https://elastic.test"],
    ["chat", "https://chat.test"],
    ["stories", "https://stories.test"],
    ["comments", "https://comments.test"],
    ["wallet", "https://wallet.test"],
  ] as const)("routes %s to its own backend", (server, expected) => {
    expect(resolveBaseUrl(server, "/whatever", ENV, guest)).toBe(expected);
  });

  it("returns empty string when the env var is missing, so the caller fails", () => {
    expect(resolveBaseUrl("wallet", "/balance", {}, guest)).toBe("");
  });
});

describe("tokenForServer", () => {
  const jar = jarWith({
    [COOKIE_NAMES.MARKET_TOKEN]: "market-jwt",
    [COOKIE_NAMES.CHAT_TOKEN]: "chat-jwt",
    [COOKIE_NAMES.STORIES_TOKEN]: "stories-jwt",
    [COOKIE_NAMES.WALLET_TOKEN]: "wallet-jwt",
    [COOKIE_NAMES.USER_ID_HASH]: "user-hash",
  });

  it.each([
    ["market", "market-jwt"],
    ["market-dashboard", "market-jwt"],
    ["chat", "chat-jwt"],
    ["stories", "stories-jwt"],
    ["wallet", "wallet-jwt"],
    ["comments", "user-hash"],
  ] as const)("gives %s its own credential", (server, expected) => {
    expect(tokenForServer(server, jar)).toBe(expected);
  });

  it("sends no credential to elastic", () => {
    expect(tokenForServer("elastic", jar)).toBe("");
  });

  it("returns empty when the cookie is absent rather than throwing", () => {
    expect(tokenForServer("market", parseCookies("lang=en"))).toBe("");
  });
});

describe("buildProxyHeaders", () => {
  const jar = jarWith({ [COOKIE_NAMES.MARKET_TOKEN]: "market-jwt" });

  it("carries locale in every shape the backends expect", () => {
    const headers = buildProxyHeaders("market", "sy", "ar", jar);
    expect(headers["lang"]).toBe("ar");
    expect(headers["Accept-Language"]).toBe("ar");
    expect(headers["x-lang"]).toBe("ar");
    expect(headers["country"]).toBe("sy");
    expect(headers["countryCode"]).toBe("SY");
  });

  it("injects the bearer token from the cookie", () => {
    expect(buildProxyHeaders("market", "sy", "ar", jar)["Authorization"]).toBe(
      "Bearer market-jwt",
    );
  });

  it("omits Authorization entirely when there is no token", () => {
    const headers = buildProxyHeaders("elastic", "sy", "ar", jar);
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("defaults the role to -1 when USER-CHAT is missing", () => {
    expect(buildProxyHeaders("market", "sy", "ar", jar)["current_role_id"]).toBe(
      "-1",
    );
  });

  it("reads the role from USER-CHAT when present", () => {
    const withChat = jarWith({
      [COOKIE_NAMES.USER_CHAT]: encodeURIComponent(
        JSON.stringify({ role_id: "7" }),
      ),
    });
    expect(
      buildProxyHeaders("market", "sy", "ar", withChat)["current_role_id"],
    ).toBe("7");
  });

  it("adds the seller header only when a seller id is given", () => {
    expect(buildProxyHeaders("market", "sy", "ar", jar)["X-Seller-ID"]).toBeUndefined();
    expect(
      buildProxyHeaders("market", "sy", "ar", jar, "seller-9")["X-Seller-ID"],
    ).toBe("seller-9");
  });
});
