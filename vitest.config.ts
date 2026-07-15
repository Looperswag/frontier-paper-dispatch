import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["config/**/*.ts", "lib/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // Ratchet upward with each remediated module; the final gate is at least 80%.
      thresholds: {
        branches: 64,
        functions: 66,
        lines: 72,
        statements: 69,
      },
    },
  },
});
