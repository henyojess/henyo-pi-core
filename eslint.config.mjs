import js from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// ESLint handles style rules and integrates with Prettier.
// Type-aware checks (unused type-only imports, undefined type-position
// names) are handled by `tsc` (`noUnusedLocals: true` + `tsc --noEmit`
// in the `lint` script). The TS parser here resolves type positions, so
// `no-undef` stays enabled for `.ts` with no false positives.
export default [
  js.configs.recommended,
  prettier,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // `no-unused-vars` (on by default via js.configs.recommended) is
      // replaced by the TS-aware variant for .ts.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "no-console": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "*.config.*"],
  },
];
