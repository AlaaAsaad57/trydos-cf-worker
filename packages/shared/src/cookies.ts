/** Cookie reading for the Workers runtime.
 *
 *  Replaces `cookies()` from `next/headers`, which is the only Next-specific
 *  dependency in `trydos/utils/server/tokenManager.ts`. Everything else in that
 *  module is plain string work, so this file is the whole of the port's
 *  runtime adaptation.
 *
 *  Cookies arrive as one `Cookie:` header, `name=value` pairs separated by
 *  "; ". Two details that a naive `split("=")` gets wrong:
 *
 *    - Values may themselves contain "=", notably base64 and JWT payloads.
 *      Split on the FIRST "=" only.
 *    - Duplicate names are possible (same name, different Path/Domain). The
 *      browser sends the more specific one first, so first-wins matches what
 *      `cookies().get()` returns. */
export const parseCookies = (header: string | null): Map<string, string> => {
  const jar = new Map<string, string>();
  if (!header) return jar;

  for (const part of header.split(";")) {
    const segment = part.trim();
    if (!segment) continue;

    const eq = segment.indexOf("=");
    if (eq < 1) continue; // no "=", or an empty name — neither is a cookie

    const name = segment.slice(0, eq).trim();
    if (jar.has(name)) continue; // first wins, see above

    jar.set(name, segment.slice(eq + 1).trim());
  }

  return jar;
};

/** The `getSecureCookie` of `tokenManager.ts:269`, name and all.
 *
 *  The name is a misnomer inherited from the original: there is no signing or
 *  encryption involved, just percent-decoding and a JSON parse. It is kept so
 *  the two files read the same. On a parse failure it returns the raw string
 *  rather than throwing, which is what the original does and what keeps
 *  routing decisions failing open to "guest".
 *
 *  Source: tokenManager.ts getSecureCookie() */
export const readJsonCookie = <T = unknown>(
  jar: Map<string, string>,
  name: string,
): T | string | null => {
  const raw = jar.get(name);
  if (raw === undefined) return null;

  // Decode until it parses, bounded — NOT a single decode.
  //
  // The original writes these with encodeURIComponent(JSON.stringify(v)) and
  // hands the result to Next's cookie serializer, which encodes again. On the
  // way back Next's reader decodes once and getSecureCookie decodes a second
  // time, so Next tolerates a double-encoded value. A single decode here does
  // not, and the failure is silent and expensive: JSON.parse throws, the raw
  // string is returned, hasValidPhone finds no phone, and a verified shopper
  // is quietly demoted to a guest and routed to the gateway.
  //
  // Verified against production 2026-08-24: with a double-encoded User-Data,
  // Next answered `core` and this function's single-decode version answered
  // `gateway`.
  //
  // Parse BEFORE decoding again, so a value whose JSON legitimately contains
  // percent sequences is never over-decoded.
  let current = raw;
  for (let pass = 0; pass < 5; pass += 1) {
    try {
      return JSON.parse(current) as T;
    } catch {
      // not JSON yet — try peeling one more layer
    }
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // malformed escape; fail open below
    }
    if (next === current) break;
    current = next;
  }

  // Fails open to the raw string rather than throwing, which is what the
  // original does and what keeps routing degrading to "guest" instead of 500.
  return raw;
};
