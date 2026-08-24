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
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as T;
  } catch {
    return raw;
  }
};
