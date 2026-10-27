import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "release/**", "uploads/**", "build/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.js", "src/**/*.js", "src/**/*.cjs", "test/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        helios: "readonly",
        api: "readonly",
        LineUtil: "readonly",
        module: "readonly",
      },
    },
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
