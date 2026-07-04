import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Functional style — no mutable state
      "no-param-reassign": ["error", { props: true }],
      "prefer-const": "error",
      "no-var": "error",

      // TypeScript-specific
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",

      // Pure function guard — ban console in library code (CLI entry is exempt)
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // Test files: loosen some rules
    files: ["src/**/*.test.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // CLI entry: allow process.exit, stdout writes
    files: ["src/index.ts"],
    rules: {
      "no-console": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
