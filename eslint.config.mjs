import eslint from "@eslint/js";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

const files = ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "packages/cli/src/**/*.ts"];
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      ".github/opengrep/vendor/**",
      "data/**",
      "coverage/**",
    ],
  },
  ...[
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    security.configs.recommended,
    sonarjs.configs.recommended,
  ].map((config) => ({ ...config, files })),
  {
    files,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
