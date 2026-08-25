import {
  buildIngestRequestHeaders,
  filterIngestResponseHeaders,
  resolveIngestTarget,
} from "@cf/shared";

/** The PostHog ingest proxy, ported from `trydos/app/ingest/[...path]/route.ts`.
 *
 *  Why it moved here: the Next route is an edge function, so every captured
 *  event, autocapture hit and feature-flag call was one Vercel invocation plus
 *  the transfer both ways — the two line items that dominate the April invoice
 *  (CLAUDE.md §1). Session replay was switched off in
 *  `trydos/utils/posthog.ts:67-72` for exactly that reason. None of that cost
 *  exists on Cloudflare.
 *
 *  Everything the Next route guarded, this guards identically. The rules live
 *  in `packages/shared/src/ingest.ts` so they can be unit-tested outside the
 *  runtime; the comments explaining *why* each one exists live there too. */

/** The upstream call, with the fetcher as a parameter.
 *
 *  The parameter exists for one reason: the contract that matters most here is
 *  "a PostHog outage must never throw into the app" (route.ts:72), and a
 *  network-level failure cannot be simulated through miniflare's outbound
 *  service — a throw there arrives as a 500 *response*, which is a different
 *  path entirely. Production always uses the global fetch. */
export const proxyIngest = async (
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> => {
    // The SDK sends GET (assets, flags), POST (capture, replay) and OPTIONS
    // (preflight). The Next route exported exactly those three, plus HEAD for
    // free via GET. Anything else is not a client of ours.
  const method = request.method;
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "POST" &&
    method !== "OPTIONS"
  ) {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD, POST, OPTIONS" },
    });
  }

  const url = new URL(request.url);
  const target = resolveIngestTarget(url.pathname, url.search);
  if (!target.ok) return new Response(null, { status: 404 });

  const headers = buildIngestRequestHeaders(
    request.headers,
    request.headers.get("cf-connecting-ip"),
  );

  // Body is streamed rather than buffered through arrayBuffer() as the Next
  // route did. Replay chunks and batched capture payloads can be large and
  // there is no reason for them to land in the isolate's 128 MB.
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetcher(target.url, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      // Assets carry PostHog's own `public, max-age=14400`, so let the edge
      // cache honour it. No cacheTtl override: the upstream decides, and a
      // stale array.js served for longer than PostHog intended is a bug we
      // would have no way to see. The event paths get no cf hint at all —
      // they must never be cached.
      ...(target.isAsset ? { cf: { cacheEverything: true } } : {}),
    });
  } catch {
    // Never let the proxy throw into the app — analytics fails silently
    // (route.ts:72). A dropped event is invisible; a broken page is not.
    // An upstream that *answers* 5xx is passed through unchanged below, so a
    // real PostHog outage still reaches the SDK's retry logic.
    return new Response(null, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterIngestResponseHeaders(upstream.headers),
  });
};

export default {
  fetch: (request: Request) => proxyIngest(request),
} satisfies ExportedHandler;
