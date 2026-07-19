import js from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import babelParser from "@babel/eslint-parser";

// ESLint handles style rules and integrates with Prettier.
// TypeScript type-checking is handled by `tsc`.
// NOTE: Full TS linting requires @typescript-eslint which is incompatible
// with TypeScript 7.x. Using @babel/eslint-parser as a fallback for style
// checks. Unused import warnings on `import type` are expected and harmless
// — TSC catches these correctly.
export default [
  js.configs.recommended,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
        },
      },
    },
    rules: {
      // Allow unused imports — TSC handles type import validation.
      // eslint-disable-next-line object-shorthand
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "no-console": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "*.config.*"],
  },
];