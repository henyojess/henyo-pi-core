import js from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import babelParser from "@babel/eslint-parser";

// ESLint handles style rules and integrates with Prettier.
// TypeScript type-checking AND unused-code detection are handled by `tsc`
// (`noUnusedLocals: true`): tsc understands type positions, so type-only
// imports used only in annotations are correctly counted as used. The babel
// parser below strips TS syntax, so eslint's `no-unused-vars` would flag
// every type-only import as a false positive — it is disabled for `.ts`.
// `no-undef` is disabled for `.ts` because the babel parser strips TS syntax
// and can't resolve type-only names, imports, or globals (false positives);
// `tsc --noEmit` (run in the same `lint` script) is authoritative for
// undefined identifiers.
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
      // `no-unused-vars` (on by default via js.configs.recommended) is disabled
      // for .ts — see header note: the babel parser can't see type-position
      // usage, so tsc (noUnusedLocals) is the authoritative unused-code checker.
      "no-unused-vars": "off",
      "no-console": "warn",
      "no-undef": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "*.config.*"],
  },
];