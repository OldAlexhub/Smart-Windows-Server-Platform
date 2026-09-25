import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
  },
});
