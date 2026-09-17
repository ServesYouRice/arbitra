import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ProtocolControlPlane } from "./registry.js";
import { assertProtocolId, parseSemver } from "./versioning.js";

/** Resolve installed assets relative to this package, never the audited repository. */
export function bundledProtocolControlPlane(): ProtocolControlPlane {
  const root = join(dirname(createRequire(import.meta.url).resolve("@arbitra/protocols/package.json")), "assets");
  return {
    async read(id, version) {
      assertProtocolId(id); parseSemver(version);
      try {
        const [protocolBytes, metadataBytes] = await Promise.all([
          readFile(join(root, id, version, "protocol.md")),
          readFile(join(root, id, version, "metadata.json")),
        ]);
        return { protocolBytes, metadataBytes, source: "trusted_base", sourceRevision: `installed:${id}@${version}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async listVersions(id) {
      assertProtocolId(id);
      try {
        return (await readdir(join(root, id), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name).filter((version) => {
          try { parseSemver(version); return true; } catch { return false; }
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
