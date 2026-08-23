const { RuleTester } = require("eslint");
const rule = require("../no-raw-color.cjs");

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

tester.run("no-raw-color", rule, {
  valid: [
    { code: "const colour = 'var(--brass)'", filename: "apps/web/src/panel.ts" },
    { code: "const colour = '#fff'", filename: "apps/web/src/tokens.css" },
    { code: "const colour = '#fff'", filename: "apps/web/src/panel.stories.ts" },
  ],
  invalid: [
    {
      code: "const colour = '#c0ffee'",
      filename: "apps/web/src/panel.ts",
      errors: [{ messageId: "rawColor" }],
    },
    {
      code: "const colour = `rgba(0, 0, 0, 0.5)`",
      filename: "apps/web/src/panel.ts",
      errors: [{ messageId: "rawColor" }],
    },
  ],
});
