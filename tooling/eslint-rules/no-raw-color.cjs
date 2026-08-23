/**
 * ESLint rule: no-raw-color
 * Destination: tooling/eslint-rules/no-raw-color.cjs
 *
 * R2 of the design language says colour is semantic — six hues, one meaning
 * each. That rule is only real if it is mechanical, which is how this project
 * treats every other invariant (cf. TASK-004, which makes the determinism
 * rules a lint failure so they cannot erode).
 *
 * Fails on a colour literal anywhere outside the token file.
 */

const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color-mix|oklch|lab)\s*\(/;

const ALLOWED_FILES = [/tokens\.css$/, /\.stories\.[jt]sx?$/];

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Colour must come from a design token. See docs/DESIGN-LANGUAGE.md R2.",
    },
    schema: [],
    messages: {
      rawColor:
        "Raw colour literal '{{value}}'. Use a design token (var(--brass), var(--steel), …). " +
        "A hue used decoratively steals from the meaning it carries elsewhere — " +
        "see docs/DESIGN-LANGUAGE.md R2. If this genuinely needs a new colour, " +
        "that is a change to tokens.css and to the design language, not to this file.",
    },
  },

  create(context) {
    const filename = context.getFilename();
    if (ALLOWED_FILES.some((re) => re.test(filename))) return {};

    function check(node, value) {
      if (typeof value !== "string") return;
      const match = value.match(COLOR_LITERAL);
      if (match) {
        context.report({ node, messageId: "rawColor", data: { value: match[0] } });
      }
    }

    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      JSXAttribute(node) {
        if (node.value && node.value.type === "Literal") {
          check(node, node.value.value);
        }
      },
    };
  },
};
