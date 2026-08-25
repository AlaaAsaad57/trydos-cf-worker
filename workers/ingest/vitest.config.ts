import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Runs the handler in workerd. See test/ingest.worker.test.ts for what the
// real runtime buys us over Node here.
//
// NOTE: @cloudflare/vitest-pool-workers 0.22 dropped the `./config` subpath
// and `defineWorkersConfig`; the pool is now a Vite plugin, and vitest 4 is a
// hard peer requirement. Do not "restore" the old import.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // PostHog is intercepted by an outbound service that echoes what it
        // received, so the tests assert on the forwarded request directly.
        async outboundService(request) {
          const url = new URL(request.url);

          if (url.pathname.endsWith("/__boom")) throw new Error("connection reset");
          if (url.pathname.endsWith("/__cookie")) {
            return new Response("ok", {
              headers: {
                "set-cookie": "ph_phc_x=1; Path=/",
                "content-type": "text/plain",
                "cache-control": "public, max-age=14400",
              },
            });
          }

          const seenHeaders: Record<string, string> = {};
          request.headers.forEach((v, k) => {
            seenHeaders[k.toLowerCase()] = v;
          });

          return Response.json({
            seenUrl: request.url,
            seenMethod: request.method,
            seenHeaders,
            seenBody: request.body ? await request.text() : null,
          });
        },
      },
    }),
  ],
});
