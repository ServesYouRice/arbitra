import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import noRawColor from "./tooling/eslint-rules/no-raw-color.cjs";
import noWorkflowNondeterminism from "./tooling/eslint-rules/no-workflow-nondeterminism.cjs";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "implementation/**", "docs/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/{core,workflow,persistence}/src/**/*.{js,jsx,ts,tsx}"],
    plugins: {
      arbitra: {
        rules: {
          "no-workflow-nondeterminism": noWorkflowNondeterminism,
        },
      },
    },
    rules: {
      "arbitra/no-workflow-nondeterminism": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{js,jsx,ts,tsx}"],
    plugins: {
      arbitra: {
        rules: {
          "no-raw-color": noRawColor,
        },
      },
    },
    rules: {
      "arbitra/no-raw-color": "error",
    },
  },
);
