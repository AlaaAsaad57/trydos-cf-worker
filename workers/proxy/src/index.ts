import {
  buildProxyHeaders,
  fromServiceToken,
  isAllowedServer,
  isBlockedOtpTarget,
  parseCookies,
  resolveBaseUrl,
  resolveTarget,
  tokenForServer,
  type BackendEnv,
} from "@cf/shared";

/** The market proxy, ported from `trydos/app/api/proxy/route.ts`.
 *
 *  Bound to a route pattern on the SAME hostname the app serves from. That is
 *  not a preference: the auth cookies are host-only (no Domain attribute), so
 *  a Worker on a sibling subdomain would never receive MARKET-TOKEN. See
 *  CLAUDE.md §3.4. */

export interface Env extends BackendEnv {}

// Source: trydos/utils/endpointConfig.tsx
const SEND_OTP = "/auth/phone/send_otp";

/** The proxy's single failure answer.
 *
 *  An unrecognised service identifier and a recognised one whose upstream call
 *  fails must be indistinguishable, or the pair becomes a way of discovering
 *  which service names are real. Both cases return this exact response, built
 *  here and nowhere else, so status, body and headers cannot drift apart.
 *
 *  Residual, inherited from the original: the unrecognised case answers before
 *  any upstream call, so it comes back sooner. That timing difference is not
 *  closed here — doing so would mean delaying a real failure on purpose. */
const proxyFailure = () =>
  Response.json(
    { message: "Proxy request failed" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

const badTarget = () =>
  Response.json(
    { error: "Invalid target URL" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );

/** The proxy metadata one request carries, however it was addressed. */
interface ProxyCall {
  /** Internal service name, already mapped back from the opaque wire token. */
  server: string;
  targetUrl: string;
  needDecode: boolean;
  method: string;
  country: string;
  language: string;
  sellerId?: string;
  /** false on the GET contract, where there is no body and none may travel. */
  allowBody: boolean;
}

/** The POST contract: metadata in `x-proxy-*` headers, body forwarded.
 *
 *  This is what every client-side call in the app uses, through
 *  `trydos/utils/fetchData.ts`. */
const callFromHeaders = (request: Request): ProxyCall => ({
  server: fromServiceToken(request.headers.get("x-proxy-server") ?? ""),
  targetUrl: request.headers.get("x-proxy-url") ?? "",
  needDecode: (request.headers.get("x-need-decode") ?? "") === "true",
  method: request.headers.get("x-proxy-method") ?? "GET",
  country: request.headers.get("x-country") ?? "sy",
  language: request.headers.get("x-language") ?? "en",
  sellerId: request.headers.get("x-seller-id") ?? undefined,
  allowBody: true,
});

/** The GET contract: the same metadata in the query string.
 *
 *  It exists for one reason — a request the browser can start while it is still
 *  parsing the document. A `<link rel="preload">` issues a plain GET and can
 *  carry no custom header, so the POST contract above is unreachable from one.
 *
 *  Three things are fixed here rather than read, and each closes a hole the
 *  header contract does not have:
 *
 *   - The method is always GET. The query may not choose it, so this route can
 *     never reach a write endpoint from a plain URL.
 *   - There is no body, on purpose (`allowBody: false`).
 *   - Cross-site callers are refused, below. The POST contract is protected by
 *     its own custom headers: they force a CORS preflight a cross-origin page
 *     cannot pass. A plain GET has no preflight, so that has to be written out.
 *
 *  The parameter names are single letters because the target path now travels
 *  in the URL, where it lands in access logs and referrers — shorter is a
 *  little less to leak, and the service value is already an opaque token.
 *
 *  Mirrors `trydos/app/api/proxy/route.ts` `callFromQuery`. */
const callFromQuery = (url: URL): ProxyCall => ({
  server: fromServiceToken(url.searchParams.get("s") ?? ""),
  targetUrl: url.searchParams.get("u") ?? "",
  needDecode: url.searchParams.get("d") === "true",
  method: "GET",
  country: url.searchParams.get("c") ?? "sy",
  language: url.searchParams.get("l") ?? "en",
  sellerId: url.searchParams.get("sid") ?? undefined,
  allowBody: false,
});

/** Is this GET coming from our own pages?
 *
 *  `Sec-Fetch-Site` is set by the browser and cannot be set by page script, so
 *  a value other than "same-origin" means another site made the request.
 *  `Origin` is checked as a second signal for the same reason.
 *
 *  A missing `Sec-Fetch-Site` is allowed. Every current browser sends it, so an
 *  attack from a browser is caught; refusing when it is absent would only break
 *  older clients while stopping nothing. The GET path is read-only and its
 *  response is not readable across origins, so what is left is bounded.
 *
 *  The Worker is bound to the app's own hostname (see the note at the top), so
 *  the request URL's origin IS the app's origin — the same comparison the Next
 *  route makes against `request.nextUrl.origin`. */
const isSameOriginGet = (request: Request, url: URL): boolean => {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return false;

  return true;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Two wire contracts, and only two. POST is what every client-side call
    // uses through fetchData.ts; GET exists so a `<link rel="preload">` can
    // start a call while the document is still being parsed. Anything else is
    // not a client of ours.
    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST", "Cache-Control": "no-store" },
      });
    }

    try {
      const url = new URL(request.url);

      // 1. Proxy metadata, from whichever contract addressed us. The wire value
      // for the service is an opaque token; both readers map it back to the
      // internal name before any validation runs, so the allowlist, the token
      // lookup and the routing below all work with readable names.
      if (request.method === "GET" && !isSameOriginGet(request, url)) {
        // Same answer as every other refusal, from the same place, so a probe
        // cannot tell one kind of rejection from another. See proxyFailure().
        return proxyFailure();
      }

      const call =
        request.method === "GET" ? callFromQuery(url) : callFromHeaders(request);
      const { server, method, country, language, sellerId, allowBody } = call;
      let targetUrl = call.targetUrl;

      // 2. Validate the service. Same answer as the generic failure, from the
      // same place, so the mapping cannot be recovered by probing.
      if (!isAllowedServer(server)) return proxyFailure();

      if (!targetUrl) {
        return Response.json(
          { error: "Missing target URL" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }

      if (call.needDecode) targetUrl = decodeURI(targetUrl);

      const jar = parseCookies(request.headers.get("Cookie"));

      // 3. Which backend answers. Routing reads the User-Data cookie for the
      // market case; it is load steering, never authorization.
      const baseUrlString = resolveBaseUrl(server, targetUrl, env, jar);
      if (!baseUrlString) return proxyFailure(); // missing env var

      // 4. SSRF containment: host cannot be rewritten, path cannot climb out
      // of the base. See packages/shared/src/guards.ts for each attack shape.
      const resolution = resolveTarget(baseUrlString, targetUrl);
      if (!resolution.ok) return badTarget();

      // 5. OTP send must NEVER go through the generic proxy — it runs only via
      // the sendOtpAction Server Action, which enforces the Redis rate limit
      // before the backend is reached. Blocking it here stops the proxy being
      // used as an open relay around that limiter.
      if (isBlockedOtpTarget(SEND_OTP, targetUrl, resolution.decodedPath)) {
        return Response.json(
          { error: "Forbidden" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      const headers = buildProxyHeaders(server, country, language, jar, sellerId);

      // 6. Body. Unlike the Next route, this streams rather than buffering:
      // no formData() parse, no json() round-trip. That keeps the isolate
      // inside its 128 MB and well under the CPU limit, and it preserves the
      // multipart boundary for free by forwarding the original Content-Type.
      let body: BodyInit | null = null;
      const contentType = request.headers.get("content-type") ?? "";

      // `allowBody` is false on the GET contract. There is nothing to read
      // there, and nothing may be forwarded.
      if (allowBody && method !== "GET" && method !== "HEAD") {
        // The one case that cannot stream: Firebase device registration wants
        // the token inside the JSON body, not just the header.
        if (targetUrl === "/firebase_device_tokens" && server === "market") {
          const rawBody = await request.text();
          if (rawBody) {
            try {
              const parsed = JSON.parse(rawBody);
              const authToken = tokenForServer(server, jar);
              if (authToken) parsed.auth_token = authToken;
              body = JSON.stringify(parsed);
            } catch {
              body = rawBody; // malformed JSON is forwarded as-is, as before
            }
            headers["Content-Type"] = "application/json";
          }
        } else {
          body = request.body;
          if (contentType) headers["Content-Type"] = contentType;
        }
      }

      // 7. Forward. Headers are built from scratch above, so no Cookie header
      // is ever copied — the upstream call carries the Bearer token and
      // nothing else of the user's session.
      const upstream = await fetch(resolution.url.href, {
        method,
        headers,
        body,
        redirect: "manual",
      });

      // 8. Which market backend answered, so the routing decision can be read
      // off the response instead of out of a log. Role names only, never the
      // backing technology.
      const extra: Record<string, string> = { "Cache-Control": "no-store" };
      if (server === "market") {
        if (baseUrlString === env.GO_BACKEND_URL)
          extra["x-market-backend"] = "gateway";
        else if (baseUrlString === env.BACKEND_URL)
          extra["x-market-backend"] = "core";
      }

      if (upstream.status === 204) {
        return new Response(null, { status: 204, headers: extra });
      }

      // 9. Stream the response straight back. The Next route re-serialised
      // JSON here; forwarding bytes is cheaper and cannot change them.
      const responseHeaders = new Headers(extra);
      const upstreamType = upstream.headers.get("content-type");
      if (upstreamType) responseHeaders.set("Content-Type", upstreamType);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch {
      // Every unexpected failure collapses into the same answer as an unknown
      // service. Nothing about the cause reaches the client.
      return proxyFailure();
    }
  },
} satisfies ExportedHandler<Env>;
