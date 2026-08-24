import { describe, expect, it } from "vitest";
import {
  escapesHost,
  fullyDecode,
  isBlockedOtpTarget,
  resolveTarget,
} from "./guards";

// A base with a path prefix, like the market backends ("/api/v1"), and one
// that is a bare host, like wallet/stories/elastic/chat/comments.
const PATHED_BASE = "https://backend.example.test/api/v1";
const BARE_BASE = "https://wallet.example.test";

describe("fullyDecode", () => {
  it("leaves a plain string alone", () => {
    expect(fullyDecode("/cart/items")).toBe("/cart/items");
  });

  it("decodes a single layer", () => {
    expect(fullyDecode("/send%5Fotp")).toBe("/send_otp");
  });

  it("decodes nested escapes that survive one pass", () => {
    expect(fullyDecode("/send%255Fotp")).toBe("/send_otp");
    // Leading "/" plus two decoded "%2F" — the shape escapesHost must catch.
    expect(fullyDecode("/%252F%252Fevil.tld")).toBe("///evil.tld");
  });

  it("returns what it has on a malformed escape rather than throwing", () => {
    expect(() => fullyDecode("%E0%A4%A")).not.toThrow();
    expect(fullyDecode("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("is bounded — a deeply nested input cannot spin", () => {
    // 20 layers of encoding; the loop stops at 5 and returns partially decoded.
    let nested = "_";
    for (let i = 0; i < 20; i += 1) nested = encodeURIComponent(nested);
    expect(() => fullyDecode(nested)).not.toThrow();
  });
});

describe("escapesHost", () => {
  it("accepts an ordinary on-host absolute path", () => {
    expect(escapesHost("/cart/items")).toBe(false);
  });

  it.each([
    ["relative, no leading slash", "cart/items"],
    ["userinfo host rewrite", "@evil.tld/x"],
    ["protocol-relative", "//evil.tld/x"],
    ["backslash normalized to //", "/\\evil.tld/x"],
    ["absolute url", "https://evil.tld/x"],
    ["empty", ""],
  ])("rejects %s", (_label, target) => {
    expect(escapesHost(target)).toBe(true);
  });
});

describe("resolveTarget", () => {
  it("resolves a normal path under a pathed base", () => {
    const result = resolveTarget(PATHED_BASE, "/cart/items");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.href).toBe(
        "https://backend.example.test/api/v1/cart/items",
      );
    }
  });

  it("resolves under a bare-host base", () => {
    const result = resolveTarget(BARE_BASE, "/balance");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.href).toBe("https://wallet.example.test/balance");
    }
  });

  // The attack the origin+path containment check exists for: a single leading
  // slash that the URL parser resolves upward, out of /api/v1 but still on the
  // backend host, carrying the injected Bearer token.
  it("rejects traversal that escapes the base path but keeps the host", () => {
    const result = resolveTarget(PATHED_BASE, "/../../internal/admin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-base");
  });

  it("rejects a host rewrite via userinfo", () => {
    const result = resolveTarget(BARE_BASE, "@evil.tld/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("escapes-host");
  });

  // decodeURI leaves %2F escaped, so this shape reaches the guard still
  // looking like a plain path.
  it("rejects an encoded protocol-relative target", () => {
    const result = resolveTarget(BARE_BASE, "/%2F%2Fevil.tld/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("escapes-host");
  });

  it("rejects a doubly-encoded protocol-relative target", () => {
    const result = resolveTarget(BARE_BASE, "/%252F%252Fevil.tld/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("escapes-host");
  });

  // "/api/v1" must not match "/api/v1evil" — hence the trailing slash in
  // basePathPrefix.
  it("does not treat a sibling path with a shared prefix as inside the base", () => {
    const result = resolveTarget("https://backend.example.test/api", "/../apiv2/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-base");
  });

  it("exposes the fully decoded resolved path for downstream matching", () => {
    const result = resolveTarget(PATHED_BASE, "/auth/phone/send%255Fotp");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decodedPath).toContain("send_otp");
  });
});

describe("isBlockedOtpTarget", () => {
  const SEND_OTP = "send_otp";

  it("blocks the plain path", () => {
    const resolved = resolveTarget(PATHED_BASE, "/auth/phone/send_otp");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(
      isBlockedOtpTarget(SEND_OTP, "/auth/phone/send_otp", resolved.decodedPath),
    ).toBe(true);
  });

  it("blocks a single-encoded path that a backend router would decode", () => {
    const target = "/auth/phone/send%5Fotp";
    const resolved = resolveTarget(PATHED_BASE, target);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(isBlockedOtpTarget(SEND_OTP, target, resolved.decodedPath)).toBe(true);
  });

  it("blocks a double-encoded path that survives one decode pass", () => {
    const target = "/auth/phone/send%255Fotp";
    const resolved = resolveTarget(PATHED_BASE, target);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(isBlockedOtpTarget(SEND_OTP, target, resolved.decodedPath)).toBe(true);
  });

  it("allows an unrelated auth path", () => {
    const target = "/auth/phone/verify";
    const resolved = resolveTarget(PATHED_BASE, target);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(isBlockedOtpTarget(SEND_OTP, target, resolved.decodedPath)).toBe(false);
  });
});
