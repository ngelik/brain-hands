import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["tests/release/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
