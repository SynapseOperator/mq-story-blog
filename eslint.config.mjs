import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".agents/**",
    "src/generated/prisma/**",
  ]),
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "prisma.config.ts"],
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", Request: "readonly", Response: "readonly", AbortSignal: "readonly" } },
  },
]);

export default eslintConfig;
