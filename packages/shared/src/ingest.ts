/** PostHog reverse proxy, ported from `trydos/app/ingest/[...path]/route.ts`.
 *
 *  WHY this proxy exists at all, kept from the original because it is the one
 *  thing that must not be "simplified" away: `/ingest` is on our own domain, so
 *  the browser attaches EVERY first-party cookie to every request — the
 *  User-Data profile JSON, MARKET-TOKEN, DEVICE-TOKEN, the 128-char
 *  USER_ID_HASH, the locale cookies. For a logged-in shopper that clears ~8 KB
 *  and PostHog's upstream rejects oversized request headers with 400. A plain
 *  rewrite forwards them verbatim; this strips `Cookie` and nothing else of
 *  consequence, which keeps the ad-blocker-resistant first-party path working.
 *
 *  If you change a rule here, change it in the Next route too — a divergence
 *  means one of the two is wrong and nothing will tell you which. */

export const INGEST_ASSETS_HOST = "https://eu-assets.i.posthog.com";
export const INGEST_EVENTS_HOST = "https://eu.i.posthog.com";

/** Route prefixes this Worker answers on.
 *
 *  `/ingest-edge` is the shadow route: it exists so the Worker can be compared
 *  against the live Next route before cutover, exactly as `/api/proxy-edge`
 *  was used in CLAUDE.md §3.13. The prefix is stripped before the upstream URL
 *  is built, so both prefixes produce an identical forwarded path — otherwise
 *  the comparison would be worthless. */
const PREFIXES = ["/ingest-edge", "/ingest"] as const;

/** Request headers we must NOT forward upstream.
 *
 *  `cookie` is the whole point (see above). The rest are hop-by-hop or
 *  connection headers that the runtime sets itself; forwarding them corrupts
 *  the upstream request.
 *
 *  Source: route.ts:26-33 */
const STRIP_REQUEST_HEADERS = new Set([
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

/** Response headers we must NOT forward back.
 *
 *  The runtime has already decoded the upstream body, so a lingering
 *  `content-encoding` / `content-length` makes the browser try to decode it
 *  again and fail. `set-cookie` is dropped so PostHog cannot plant cookies on
 *  our own hostname — which would then be sent back up on every subsequent
 *  request and reintroduce the header-size problem this proxy exists to solve.
 *
 *  Source: route.ts:39-45 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

export type IngestResolution =
  | { ok: true; url: string; isAsset: boolean }
  | { ok: false };

/** Map an incoming `/ingest/*` path onto its PostHog upstream.
 *
 *  Asset requests (`/ingest/static/*`) go to the assets host; everything else
 *  — capture `/e/`, `/i/v0/e/`, replay `/s/`, `/flags/` — goes to the
 *  ingestion host (route.ts:51-54).
 *
 *  The upstream is built by concatenating a fixed base with the remainder of
 *  our own pathname, and the remainder always begins with "/". There is no
 *  attacker-controlled component before the path, so none of the host-rewrite
 *  shapes that `guards.ts` defends against apply here — the tests assert that
 *  rather than taking it on trust. */
export const resolveIngestTarget = (
  pathname: string,
  search: string,
): IngestResolution => {
  const prefix = PREFIXES.find(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!prefix) return { ok: false };

  // What is left after the prefix, e.g. "/static/array.js" or "/e/". A bare
  // prefix has nothing to forward — the Next catch-all would not match it
  // either, so 404 is the parity answer.
  const rest = pathname.slice(prefix.length);
  if (rest === "" || rest === "/") return { ok: false };

  // Whole-segment match. "staticfoo" is an ingestion path, and sending it to
  // the assets host would 404 every request under it.
  const isAsset = rest.slice(1).split("/")[0] === "static";

  return {
    ok: true,
    isAsset,
    url: `${isAsset ? INGEST_ASSETS_HOST : INGEST_EVENTS_HOST}${rest}${search}`,
  };
};

/** Copy the request headers PostHog should see.
 *
 *  `clientIp` becomes `X-Forwarded-For`. This is the one deliberate difference
 *  from the Next route: there, Vercel happened to have populated the header
 *  already and it was copied along. In a Worker nothing does that for us, and
 *  the failure is silent — PostHog would geolocate every event to whichever
 *  Cloudflare PoP served it. Same class of bug as the CLAUDE.md §5a geo fix,
 *  so it is set explicitly rather than inherited by luck. */
export const buildIngestRequestHeaders = (
  source: Headers,
  clientIp: string | null,
): Headers => {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  if (clientIp) headers.set("X-Forwarded-For", clientIp);
  return headers;
};

/** Copy the response headers the browser should see. */
export const filterIngestResponseHeaders = (source: Headers): Headers => {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
};
