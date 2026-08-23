/** Enforces activity boundaries around workflow-relevant nondeterminism. */

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const ESCAPE_MARKER = "arbitra-determinism: allow";

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Require workflow nondeterminism to occur inside activity callbacks.",
    },
    schema: [],
    messages: {
      outsideActivity:
        "{{operation}} is workflow-relevant nondeterminism in {{layer}}. " +
        "Invoke it inside an activity() callback so replay remains deterministic.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const childProcessBindings = new Map();

    function layerName() {
      return context.getFilename().replace(/\\/g, "/");
    }

    function isActivityCall(node) {
      if (!node || node.type !== "CallExpression") return false;
      if (node.callee.type === "Identifier") return node.callee.name === "activity";
      return node.callee.type === "MemberExpression" && !node.callee.computed
        && node.callee.property.type === "Identifier" && node.callee.property.name === "activity";
    }

    function isInsideActivityCallback(node) {
      for (let current = node.parent; current; current = current.parent) {
        if (
          ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(current.type)
          && isActivityCall(current.parent)
          && current.parent.arguments.includes(current)
        ) {
          return true;
        }
      }
      return false;
    }

    function hasEscapeMarker(node) {
      const comments = sourceCode.getAllComments();
      const startLine = node.loc?.start.line;
      if (startLine === undefined) return false;
      return comments.some((comment) =>
        comment.value.includes(ESCAPE_MARKER)
        && comment.loc.end.line >= startLine - 1
        && comment.loc.end.line <= startLine,
      );
    }

    function report(node, operation) {
      if (isInsideActivityCallback(node) || hasEscapeMarker(node)) return;
      context.report({
        node,
        messageId: "outsideActivity",
        data: { operation, layer: layerName() },
      });
    }

    function rememberChildProcessImport(node) {
      if (!CHILD_PROCESS_MODULES.has(node.source.value)) return;
      for (const specifier of node.specifiers) {
        childProcessBindings.set(
          specifier.local.name,
          specifier.type === "ImportNamespaceSpecifier" ? "namespace" : "callable",
        );
      }
    }

    function rememberChildProcessRequire(node) {
      if (node.id.type !== "Identifier" || node.init?.type !== "CallExpression") return;
      const [argument] = node.init.arguments;
      if (
        node.init.callee.type === "Identifier" && node.init.callee.name === "require"
        && argument?.type === "Literal" && CHILD_PROCESS_MODULES.has(argument.value)
      ) {
        childProcessBindings.set(node.id.name, "namespace");
      }
    }

    function childProcessOperation(node) {
      if (node.callee.type === "Identifier" && childProcessBindings.get(node.callee.name) === "callable") {
        return `child_process.${node.callee.name}()`;
      }
      if (
        node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier"
        && childProcessBindings.get(node.callee.object.name) === "namespace"
      ) {
        const method = node.callee.computed
          ? sourceCode.getText(node.callee.property)
          : node.callee.property.name;
        return `child_process.${method}()`;
      }
      return null;
    }

    return {
      ImportDeclaration: rememberChildProcessImport,
      VariableDeclarator: rememberChildProcessRequire,
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) {
          report(node, "new Date()");
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" && !node.callee.computed
          && node.callee.object.type === "Identifier" && node.callee.object.name === "Date"
          && node.callee.property.type === "Identifier" && node.callee.property.name === "now"
        ) {
          report(node, "Date.now()");
          return;
        }
        if (
          node.callee.type === "MemberExpression" && !node.callee.computed
          && node.callee.object.type === "Identifier" && node.callee.object.name === "Math"
          && node.callee.property.type === "Identifier" && node.callee.property.name === "random"
        ) {
          report(node, "Math.random()");
          return;
        }
        if (node.callee.type === "Identifier" && node.callee.name === "fetch") {
          report(node, "fetch()");
          return;
        }
        const operation = childProcessOperation(node);
        if (operation !== null) report(node, operation);
      },
    };
  },
};
