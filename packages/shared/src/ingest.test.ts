import { describe, expect, it } from "vitest";
import {
  INGEST_ASSETS_HOST,
  INGEST_EVENTS_HOST,
  buildIngestRequestHeaders,
  filterIngestResponseHeaders,
  resolveIngestTarget,
} from "./ingest";

describe("resolveIngestTarget", () => {
  it("sends /static/* to the assets host", () => {
    const r = resolveIngestTarget("/ingest/static/array.js", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe(`${INGEST_ASSETS_HOST}/static/array.js`);
    expect(r.isAsset).toBe(true);
  });

  it("sends everything else to the ingestion host", () => {
    const r = resolveIngestTarget("/ingest/i/v0/e/", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe(`${INGEST_EVENTS_HOST}/i/v0/e/`);
    expect(r.isAsset).toBe(false);
  });

  it("resolves the shadow prefix to the identical upstream URL", () => {
    // The whole point of /ingest-edge: it must be byte-for-byte comparable
    // with /ingest, so the prefix cannot leak into the forwarded path.
    const shadow = resolveIngestTarget("/ingest-edge/static/array.js", "");
    const live = resolveIngestTarget("/ingest/static/array.js", "");
    expect(shadow.ok && live.ok && shadow.url).toBe(live.ok ? live.url : "");
  });

  it("preserves the trailing slash PostHog's endpoints require", () => {
    const r = resolveIngestTarget("/ingest/e/", "");
    expect(r.ok && r.url).toBe(`${INGEST_EVENTS_HOST}/e/`);
  });

  it("preserves the query string verbatim", () => {
    const r = resolveIngestTarget("/ingest/flags/", "?v=2&ver=1.246.0");
    expect(r.ok && r.url).toBe(`${INGEST_EVENTS_HOST}/flags/?v=2&ver=1.246.0`);
  });

  it("matches 'static' as a whole segment, not a prefix", () => {
    // "staticfoo" is an ingestion path; routing it to the assets host would
    // 404 every request under it.
    const r = resolveIngestTarget("/ingest/staticfoo/x", "");
    expect(r.ok && r.url).toBe(`${INGEST_EVENTS_HOST}/staticfoo/x`);
    expect(r.ok && r.isAsset).toBe(false);
  });

  it("rejects a bare prefix with nothing to forward", () => {
    expect(resolveIngestTarget("/ingest", "").ok).toBe(false);
    expect(resolveIngestTarget("/ingest/", "").ok).toBe(false);
  });

  it("rejects a path outside the prefix", () => {
    expect(resolveIngestTarget("/api/proxy", "").ok).toBe(false);
    expect(resolveIngestTarget("/ingestion/e/", "").ok).toBe(false);
  });

  it("cannot be steered off the PostHog hosts", () => {
    // The upstream is built by concatenation, so prove the host survives the
    // shapes that rewrite a host elsewhere in this repo (see guards.ts).
    for (const p of [
      "/ingest//evil.tld/x",
      "/ingest/@evil.tld/x",
      "/ingest/%2F%2Fevil.tld/x",
      "/ingest/../../evil",
    ]) {
      const r = resolveIngestTarget(p, "");
      if (!r.ok) continue;
      expect(new URL(r.url).host).toBe(new URL(INGEST_EVENTS_HOST).host);
    }
  });
});

describe("buildIngestRequestHeaders", () => {
  const source = () =>
    new Headers({
      cookie: "MARKET-TOKEN=secret; User-Data=%257B%2522id%2522%253A1%257D",
      "content-type": "text/plain",
      "user-agent": "Mozilla/5.0",
      "accept-encoding": "gzip, br",
      origin: "https://trydos.ramaaz.dev",
    });

  it("never forwards the Cookie header", () => {
    // This is the entire reason the proxy exists: our first-party cookies
    // overflow PostHog's upstream header limit and it answers 400.
    expect(buildIngestRequestHeaders(source(), null).get("cookie")).toBeNull();
  });

  it("keeps the headers PostHog needs", () => {
    const h = buildIngestRequestHeaders(source(), null);
    expect(h.get("content-type")).toBe("text/plain");
    expect(h.get("user-agent")).toBe("Mozilla/5.0");
    expect(h.get("origin")).toBe("https://trydos.ramaaz.dev");
  });

  it("drops hop-by-hop headers the runtime sets itself", () => {
    const h = buildIngestRequestHeaders(source(), null);
    expect(h.get("accept-encoding")).toBeNull();
  });

  it("sets X-Forwarded-For from the client IP so geo-IP survives", () => {
    // Without this PostHog geolocates every event to a Cloudflare PoP.
    const h = buildIngestRequestHeaders(source(), "203.0.113.7");
    expect(h.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("overrides a client-supplied X-Forwarded-For", () => {
    const s = source();
    s.set("x-forwarded-for", "1.2.3.4");
    expect(buildIngestRequestHeaders(s, "203.0.113.7").get("x-forwarded-for"))
      .toBe("203.0.113.7");
  });

  it("leaves X-Forwarded-For alone when there is no client IP", () => {
    const s = source();
    s.set("x-forwarded-for", "1.2.3.4");
    expect(buildIngestRequestHeaders(s, null).get("x-forwarded-for")).toBe("1.2.3.4");
  });
});

describe("filterIngestResponseHeaders", () => {
  it("drops upstream Set-Cookie so PostHog cannot plant cookies on our host", () => {
    const h = filterIngestResponseHeaders(
      new Headers({ "set-cookie": "ph_id=1; Path=/", "content-type": "application/json" }),
    );
    expect(h.get("set-cookie")).toBeNull();
    expect(h.get("content-type")).toBe("application/json");
  });

  it("drops encoding headers the runtime has already applied", () => {
    const h = filterIngestResponseHeaders(
      new Headers({ "content-encoding": "gzip", "content-length": "264388" }),
    );
    expect(h.get("content-encoding")).toBeNull();
    expect(h.get("content-length")).toBeNull();
  });

  it("keeps the caching headers that make assets cheap", () => {
    const h = filterIngestResponseHeaders(
      new Headers({ "cache-control": "public, max-age=14400", etag: '"abc"' }),
    );
    expect(h.get("cache-control")).toBe("public, max-age=14400");
    expect(h.get("etag")).toBe('"abc"');
  });
});
