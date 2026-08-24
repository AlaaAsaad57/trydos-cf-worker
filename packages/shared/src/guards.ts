/** SSRF guards for the market proxy.
 *
 *  Ported verbatim in behaviour from `trydos/app/api/proxy/route.ts`. Every
 *  function here has a counterpart there, and the reasoning comments are kept
 *  because they record attacks that were actually considered. If you change a
 *  rule here, change it there too — a divergence means one of the two is
 *  wrong and nothing will tell you which.
 *
 *  These run on the Workers runtime, whose `URL` is not Node's. That is exactly
 *  why the tests for this file run inside workerd rather than under Node: a
 *  parser difference here is a token-carrying SSRF, not a failing assertion. */

/** Decode percent-escapes until the string stops changing.
 *
 *  One pass is not enough: "%252F" survives a single pass as "%2F", and
 *  "send%255Fotp" survives as "send%5Fotp" — both still reach a backend router
 *  that decodes again. The loop is bounded so a deeply nested input cannot
 *  spin, and a malformed escape returns what we have rather than throwing,
 *  which keeps the callers failing closed.
 *
 *  Source: route.ts fullyDecode() */
export const fullyDecode = (value: string): string => {
  let current = value;
  for (let pass = 0; pass < 5; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
};

/** Does this target rewrite the host instead of naming a path on it?
 *
 *  The upstream URL is built by concatenation (base + target), and several base
 *  URLs (wallet, stories, elastic, chat, comments) are bare hosts with no path
 *  component. A target that does not begin with a single "/" can therefore
 *  rewrite the host rather than the path — e.g. "@evil.tld/x" yields
 *  "https://<wallet-host>@evil.tld/x", which resolves to evil.tld and would
 *  carry the injected Bearer token off-site. "//" is protocol-relative and
 *  "/\" is normalized to "//" by some URL parsers; both escape the host the
 *  same way.
 *
 *  Source: route.ts escapesHost() */
export const escapesHost = (target: string): boolean =>
  !target.startsWith("/") ||
  target.startsWith("//") ||
  target.startsWith("/\\");

export type TargetResolution =
  | { ok: true; url: URL; decodedPath: string }
  | { ok: false; reason: "escapes-host" | "unparseable" | "outside-base" };

/** Resolve base + target and prove the result stayed inside the base.
 *
 *  The string checks in escapesHost() stop the host from being rewritten, but
 *  they say nothing about the *path*: "/../.." is a single leading slash, yet
 *  the URL parser resolves it upwards, escaping the base path. The market bases
 *  carry an "/api/v1" prefix, so "/../../x" would reach https://<host>/x —
 *  still on the backend host, but outside the API surface, carrying the
 *  injected Bearer token.
 *
 *  So: parse the URL the same way fetch() will, then require it to stay on the
 *  base's origin AND under the base's path. Callers must forward
 *  `resolution.url.href` rather than re-concatenating, so the exact string that
 *  was validated is the one that gets fetched — that removes any chance of a
 *  parser differential between this check and fetch().
 *
 *  `escapesHost` is checked against the escaped form AND the fully decoded one.
 *  The caller's decode step uses decodeURI, which leaves "%2F" escaped by
 *  design, so "/%2F%2Fevil.tld/x" arrives here still looking like a plain path
 *  while decoding to a protocol-relative address further down the line.
 *  Decoding is used only to decide, never to forward.
 *
 *  Source: route.ts lines 105-152 */
export const resolveTarget = (
  baseUrlString: string,
  targetUrl: string,
): TargetResolution => {
  const decodedTarget = fullyDecode(targetUrl);
  if (escapesHost(targetUrl) || escapesHost(decodedTarget)) {
    return { ok: false, reason: "escapes-host" };
  }

  let resolvedUrl: URL;
  let baseUrl: URL;
  try {
    resolvedUrl = new URL(baseUrlString + targetUrl);
    baseUrl = new URL(baseUrlString);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  const basePathPrefix = baseUrl.pathname.replace(/\/+$/, "") + "/";
  if (
    resolvedUrl.origin !== baseUrl.origin ||
    !resolvedUrl.pathname.startsWith(basePathPrefix)
  ) {
    return { ok: false, reason: "outside-base" };
  }

  return { ok: true, url: resolvedUrl, decodedPath: fullyDecode(resolvedUrl.pathname) };
};

/** Is this target trying to reach the OTP send endpoint?
 *
 *  OTP send must NEVER go through the generic proxy. It runs exclusively via
 *  the sendOtpAction Server Action, which enforces the Redis rate limit
 *  (per-session / per-IP / per-number cooldown) before the backend is ever
 *  called. Blocking it here stops anyone using the proxy as an open relay to
 *  reach the OTP endpoint directly and bypass that limiter.
 *
 *  Match on the *fully decoded* resolved path as well as the raw header: a
 *  backend router decodes percent-escapes before routing, so
 *  "/auth/phone/send%5Fotp" reaches send_otp while sailing past a raw substring
 *  match — and "send%255Fotp" sails past a single decode pass too. Decoding
 *  here fails closed: an over-broad match only blocks a request that must not
 *  be proxied anyway.
 *
 *  Source: route.ts lines 155-177 */
export const isBlockedOtpTarget = (
  sendOtpPath: string,
  targetUrl: string,
  decodedPath: string,
): boolean =>
  targetUrl.includes(sendOtpPath) ||
  fullyDecode(targetUrl).includes(sendOtpPath) ||
  decodedPath.includes(sendOtpPath);
