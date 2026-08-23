const { RuleTester } = require("eslint");
const rule = require("../no-workflow-nondeterminism.cjs");

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

tester.run("no-workflow-nondeterminism", rule, {
  valid: [
    "activity('clock', async () => Date.now())",
    "runtime.activity('rng', async () => Math.random())",
    "activity('network', async () => fetch('https://example.invalid'))",
    "import { exec } from 'node:child_process'; activity('shell', async () => exec('git status'))",
    "const value = new Date(0)",
    "// arbitra-determinism: allow -- adapter boundary\nDate.now()",
  ],
  invalid: [
    { code: "Date.now()", errors: [{ messageId: "outsideActivity" }] },
    { code: "new Date()", errors: [{ messageId: "outsideActivity" }] },
    { code: "Math.random()", errors: [{ messageId: "outsideActivity" }] },
    { code: "fetch('https://example.invalid')", errors: [{ messageId: "outsideActivity" }] },
    {
      code: "import { exec as run } from 'node:child_process'; run('git status')",
      errors: [{ messageId: "outsideActivity" }],
    },
    {
      code: "const cp = require('child_process'); cp.spawn('git', ['status'])",
      languageOptions: { sourceType: "script" },
      errors: [{ messageId: "outsideActivity" }],
    },
  ],
});
