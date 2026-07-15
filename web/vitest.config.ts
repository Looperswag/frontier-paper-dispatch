import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    clearMocks: true,
    environment: "jsdom",
    // One thread avoids child-process startup races when a laptop sleeps or its clock changes.
    fileParallelism: false,
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    pool: "threads",
    restoreMocks: true,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "lib/**/*.ts",
        "middleware.ts",
        "proxy.ts",
      ],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // Ratchet upward with each remediated module; the final gate is at least 80%.
      thresholds: {
        branches: 73,
        functions: 74,
        lines: 83,
        statements: 78,
      },
    },
  },
});
