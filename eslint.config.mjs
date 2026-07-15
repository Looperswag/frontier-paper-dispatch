import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "legacy/**",
      "node_modules/**",
      "node_modules.cloud-conflict.nosync/**",
      "node_modules.cloud-old.nosync/**",
      "node_modules.nosync/**",
      "web/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-irregular-whitespace": [
        "error",
        { skipComments: true, skipStrings: true, skipTemplates: true },
      ],
    },
  },
  {
    files: [
      "lib/supabase.ts",
      "scripts/fetchers/arxiv.ts",
      "scripts/fetchers/blogs.ts",
      "scripts/fetchers/github.ts",
      "scripts/fetchers/huggingface.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
