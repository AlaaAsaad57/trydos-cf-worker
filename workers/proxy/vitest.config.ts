import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Runs the handler in workerd. See test/proxy.worker.test.ts for why the
// runtime matters here rather than being a nicety.
//
// NOTE: @cloudflare/vitest-pool-workers 0.22 dropped the `./config` subpath
// and `defineWorkersConfig`; the pool is now a Vite plugin, and vitest 4 is a
// hard peer requirement. Do not "restore" the old import.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // fetchMock was removed in 0.22; upstream calls are intercepted with
        // an outbound service that echoes what it received. Tests then assert
        // on the echo, which reads better than interceptor bookkeeping.
        outboundService(request) {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/__204"))
            return new Response(null, { status: 204 });
          if (url.pathname.endsWith("/__401"))
            return Response.json({ error: "unauthorized" }, { status: 401 });
          if (url.pathname.endsWith("/__boom"))
            throw new Error("connection reset");
          return Response.json({
            seenUrl: request.url,
            seenMethod: request.method,
            seenAuth: request.headers.get("authorization"),
            seenCookie: request.headers.get("cookie"),
            seenCountryCode: request.headers.get("countrycode"),
            seenRole: request.headers.get("current_role_id"),
          });
        },
        // Test-only backends. Real values are Worker secrets, never
        // committed — CLAUDE.md §3.9.
        bindings: {
          BACKEND_URL: "https://core.test/api/v1",
          GO_BACKEND_URL: "https://gateway.test/api/v1",
          ELASTIC_BACKEND_URL: "https://elastic.test",
          NEXT_PUBLIC_CHAT_BACKEND_URL: "https://chat.test",
          STORIES_BACKEND_URL: "https://stories.test",
          COMMENT_BACKEND_URL: "https://comments.test",
          WALLET_BACKEND_URL: "https://wallet.test",
        },
      },
    }),
  ],
});
