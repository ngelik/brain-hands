import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/release/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
