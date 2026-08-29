import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// jsdom replaces the global URL, and `new URL(relative, base)` does not resolve against a
// file: base under it, so the anchor goes through node:path rather than URL resolution.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Source reads anchor to the package root, not the working directory, so a suite behaves the same run from here or from the repository root. */
export function fromPackageRoot(path: string): string { return resolve(packageRoot, path); }
