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
});
