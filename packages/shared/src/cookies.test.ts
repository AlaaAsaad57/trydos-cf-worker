import { describe, expect, it } from "vitest";
import { parseCookies, readJsonCookie } from "./cookies";

describe("parseCookies", () => {
  it("returns an empty jar for a missing header", () => {
    expect(parseCookies(null).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
  });

  it("parses a single pair", () => {
    expect(parseCookies("country=sy").get("country")).toBe("sy");
  });

  it("parses several pairs and trims surrounding space", () => {
    const jar = parseCookies("country=sy; lang=ar;  language=ar");
    expect(jar.get("country")).toBe("sy");
    expect(jar.get("lang")).toBe("ar");
    expect(jar.get("language")).toBe("ar");
  });

  // The case a split("=") port would corrupt: JWTs and base64 contain "=".
  it("keeps '=' inside the value intact", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln==";
    const jar = parseCookies(`MARKET-TOKEN=${jwt}; lang=en`);
    expect(jar.get("MARKET-TOKEN")).toBe(jwt);
    expect(jar.get("lang")).toBe("en");
  });

  it("keeps the first of a duplicated name, as the browser orders them", () => {
    const jar = parseCookies("country=sy; country=gb");
    expect(jar.get("country")).toBe("sy");
  });

  it("skips malformed segments rather than throwing", () => {
    const jar = parseCookies("; =orphan; novalue; country=sy; =");
    expect(jar.get("country")).toBe("sy");
    expect(jar.has("")).toBe(false);
    expect(jar.has("novalue")).toBe(false);
  });

  it("tolerates an empty value", () => {
    expect(parseCookies("MARKET-TOKEN=; lang=en").get("MARKET-TOKEN")).toBe("");
  });
});

describe("readJsonCookie", () => {
  it("returns null when absent", () => {
    expect(readJsonCookie(parseCookies("lang=en"), "User-Data")).toBeNull();
  });

  it("percent-decodes then JSON-parses", () => {
    const value = encodeURIComponent(JSON.stringify({ phone: "+963900000000" }));
    const jar = parseCookies(`User-Data=${value}`);
    expect(readJsonCookie(jar, "User-Data")).toEqual({ phone: "+963900000000" });
  });

  // Fails open to the raw string rather than throwing — routing must degrade
  // to "guest", never 500.
  it("returns the raw string when the value is not JSON", () => {
    const jar = parseCookies("User-Data=not-json");
    expect(readJsonCookie(jar, "User-Data")).toBe("not-json");
  });

  it("returns the raw string on a malformed percent-escape", () => {
    const jar = parseCookies("User-Data=%E0%A4%A");
    expect(readJsonCookie(jar, "User-Data")).toBe("%E0%A4%A");
  });

  // Regression: this is how the cookie actually arrives in production. The
  // value is encodeURIComponent'd by setSecureCookieJSON and then encoded
  // again by Next's cookie serializer. A single decode leaves "%7B%22id%22…",
  // JSON.parse throws, and a verified shopper is silently demoted to a guest
  // and routed to the gateway instead of core.
  it("parses a double-encoded value, as production actually sends it", () => {
    const profile = { id: 18081, phone: "+963937288307", is_verified: true };
    const doubleEncoded = encodeURIComponent(
      encodeURIComponent(JSON.stringify(profile)),
    );
    const jar = parseCookies(`User-Data=${doubleEncoded}`);
    expect(readJsonCookie(jar, "User-Data")).toEqual(profile);
  });

  it("parses an unencoded JSON value too", () => {
    const jar = parseCookies('User-Data={"phone":"+963900000000"}');
    expect(readJsonCookie(jar, "User-Data")).toEqual({
      phone: "+963900000000",
    });
  });

  // Guards the decode loop against over-decoding: a string value that itself
  // contains percent sequences must survive intact once the JSON parses.
  it("stops decoding as soon as the value parses", () => {
    const withPercents = { note: "50%25 off", path: "/a%2Fb" };
    const jar = parseCookies(
      `User-Data=${encodeURIComponent(JSON.stringify(withPercents))}`,
    );
    expect(readJsonCookie(jar, "User-Data")).toEqual(withPercents);
  });
});
