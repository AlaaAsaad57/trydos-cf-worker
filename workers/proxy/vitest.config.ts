import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Runs the handler in workerd. See test/proxy.worker.test.ts for why the
// runtime matters here rather than being a nicety.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only backends. The real values are Worker secrets and are
          // never committed — CLAUDE.md §3.9.
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
      },
    },
  },
});
