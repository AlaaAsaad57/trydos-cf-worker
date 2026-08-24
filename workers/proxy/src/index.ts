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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The wire contract is POST-only; fetchData.ts:549 never sends anything
    // else. Anything that does is not a client of ours.
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "Cache-Control": "no-store" },
      });
    }

    try {
      // 1. Proxy metadata. The wire value is an opaque token; map it back to
      // the internal service name before any validation runs, so the
      // allowlist, token lookup and routing below work with readable names.
      const server = fromServiceToken(request.headers.get("x-proxy-server") ?? "");
      let targetUrl = request.headers.get("x-proxy-url") ?? "";
      const needDecode = request.headers.get("x-need-decode") ?? "";
      const method = request.headers.get("x-proxy-method") ?? "GET";
      const country = request.headers.get("x-country") ?? "sy";
      const language = request.headers.get("x-language") ?? "en";
      const sellerId = request.headers.get("x-seller-id") ?? undefined;

      // 2. Validate the service. Same answer as the generic failure, from the
      // same place, so the mapping cannot be recovered by probing.
      if (!isAllowedServer(server)) return proxyFailure();

      if (!targetUrl) {
        return Response.json(
          { error: "Missing target URL" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }

      if (needDecode === "true") targetUrl = decodeURI(targetUrl);

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

      if (method !== "GET" && method !== "HEAD") {
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
