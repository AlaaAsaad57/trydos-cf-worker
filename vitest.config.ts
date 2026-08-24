import { defineConfig } from "vitest/config";

// Root config covers the runtime-agnostic unit tests only. The worker handler
// tests live in workers/*/vitest.config.ts because they need workerd, not
// Node — running them here would fail on the `cloudflare:test` import.
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
  },
});
