import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import type { HarnessToolDefinition, HarnessToolRuntime, HarnessToolResult } from "@arbitra/harness/adapter.js";
import { testingReadFileSchema, testingWriteFileSchema } from "@arbitra/schemas/testing-tools.js";
import { concreteWritePath, type WriteLease, type WritePartitions } from "@arbitra/security/write-partitions";
import type { TestingWorkspace } from "./testing-workspace.js";
import type { RunStore } from "./run-store.js";

const definitions: readonly HarnessToolDefinition[] = Object.freeze([
  { name: "testing_read_file", description: "Read the journal-validated current worktree file with its full-content SHA-256. Lines and Unicode-character columns are 1-based. Follow nextLine/nextColumn for bounded excerpts. Use this after writes; repo tools retain the initial snapshot.", inputSchema: testingReadFileSchema.toJSONSchema() },
  { name: "testing_write_file", description: "Create or replace one authorized test file. expectedHash must match its current full-content SHA-256; use null only to create a missing file. This does not run tests.", inputSchema: testingWriteFileSchema.toJSONSchema() },
]);
interface SavedCall { readonly name: string; readonly argumentsFingerprint: string; readonly policyIdentity: string; readonly result: HarnessToolResult }

/** Only trusted runtime composition supplies this extension. Its lease is never
 * accepted from a model argument. Each result is immutable for a durable tool call. */
export function testingToolExtension(store: RunStore, workspace: TestingWorkspace, partitions: WritePartitions, lease: WriteLease) {
  const policyIdentity = hash(lease);
  return Object.freeze({ policyIdentity, definitions,
    createRuntime(base: HarnessToolRuntime, activityId: string, signal: AbortSignal, readPaths?: readonly string[]): HarnessToolRuntime {
      const scopeIdentity = hash({ policyIdentity, readPaths: readPaths === undefined ? null : [...readPaths].sort() });
      return { async invoke(name, args, context) {
        if (!name.startsWith("testing_")) return base.invoke(name, args, context);
        if (signal.aborted) throw new Error("TESTING_TOOL_CANCELLED");
        if (context.nodeId !== activityId || context.callId === undefined || context.turn === undefined || context.callIndex === undefined) throw new Error("TESTING_TOOL_CALL_IDENTITY_REQUIRED");
        partitions.assertGranted(lease, lease.paths[0] ?? "");
        const identity = hash({ activityId, turn: context.turn, index: context.callIndex, callId: context.callId });
        const kind = `testing-tool-call-${identity}`; const argumentsFingerprint = hash(args);
        const previous = (await store.listArtifacts()).find((artifact) => artifact.kind === kind);
        if (previous !== undefined) {
          const saved = await store.artifacts.get<SavedCall>(previous.ref);
          if (saved.name !== name || saved.argumentsFingerprint !== argumentsFingerprint || saved.policyIdentity !== scopeIdentity) throw new Error("TESTING_TOOL_CALL_CHANGED");
          return saved.result;
        }
        const error = (code: string): HarnessToolResult => ({ ok: false, summary: "Testing tool request rejected", content: code, artifact: null, truncated: false, trust: "untrusted", error: { code, message: code } });
        let result: HarnessToolResult;
        const success = (value: unknown, truncated = false): HarnessToolResult => ({ ok: true, summary: name === "testing_write_file" ? "Authorized file update recorded" : "Current worktree file", content: context.protect(JSON.stringify(value), { sourceId: identity }), artifact: null, truncated, trust: "untrusted" });
        if (name === "testing_write_file") {
          const parsed = testingWriteFileSchema.safeParse(args);
          if (!parsed.success) result = error("INVALID_TESTING_WRITE_ARGUMENTS");
          else {
            try {
              partitions.assertGranted(lease, parsed.data.path);
              const written = await workspace.write(`tool/${identity}`, lease, parsed.data);
              result = success({ path: written.path, beforeHash: written.beforeHash, afterHash: written.afterHash });
            } catch (caught) {
              const code = caught instanceof Error ? caught.message.split(":")[0] ?? "" : "";
              if (!["WRITE_OUTSIDE_LEASE", "INVALID_WRITE_PATH", "CONTROL_PLANE_WRITE_FORBIDDEN", "TESTING_WRITE_CONFLICT", "TESTING_WRITE_SIZE_LIMIT"].includes(code)) throw caught;
              result = error(code);
            }
          }
        } else if (name === "testing_read_file") {
          const parsed = testingReadFileSchema.safeParse(args);
          if (!parsed.success) result = error("INVALID_TESTING_READ_ARGUMENTS");
          else {
            let valid = true;
            try { concreteWritePath(parsed.data.path); } catch { valid = false; }
            const file = valid && (readPaths === undefined || readPaths.includes(parsed.data.path)) ? (await workspace.snapshot()).files.find(({ path }) => path === parsed.data.path) : undefined;
            if (file === undefined) result = error("TESTING_FILE_NOT_IN_WORKSPACE");
            else {
              const start = parsed.data.startLine ?? 1; const end = parsed.data.endLine ?? file.lines.length;
              const column = parsed.data.startColumn ?? 1;
              if (end < start || start > file.lines.length || end > file.lines.length || column > Array.from(file.lines[start - 1] ?? "").length + 1) result = error("INVALID_TESTING_LINE_RANGE");
              else {
                const excerpt = readExcerpt(file.lines, start, end, column);
                result = success({ path: file.path, hash: createHash("sha256").update(file.lines.join("\n")).digest("hex"), startLine: start, startColumn: column, ...excerpt, totalLines: file.lines.length }, excerpt.nextLine !== null);
              }
            }
          }
        } else result = error("TESTING_TOOL_NOT_ALLOWED");
        const artifact = await store.publish(kind, { name, argumentsFingerprint, policyIdentity: scopeIdentity, result } satisfies SavedCall, activityId);
        // Return the persisted representation on the first call too, so redaction
        // and JSON property order cannot change a replayed model turn's history.
        return (await store.artifacts.get<SavedCall>(artifact.ref)).result;
      } };
    },
  });
}
export type TestingToolExtension = ReturnType<typeof testingToolExtension>;
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function readExcerpt(lines: readonly string[], start: number, end: number, column: number) {
  const output: string[] = []; let bytes = 0;
  for (let index = start - 1; index < end; index += 1) {
    const characters = Array.from(lines[index] ?? "");
    for (let offset = index === start - 1 ? column - 1 : 0; offset < characters.length; offset += 1) {
      const character = characters[offset] ?? ""; const size = Buffer.byteLength(character);
      if (bytes + size > 8192) return { content: output.join(""), endLine: index + 1, nextLine: index + 1, nextColumn: offset + 1 };
      output.push(character); bytes += size;
    }
    if (index + 1 < end) {
      // Resume at the end of this line when its separator did not fit, so joining
      // successive excerpts does not silently remove a newline.
      if (bytes === 8192) return { content: output.join(""), endLine: index + 1, nextLine: index + 1, nextColumn: characters.length + 1 };
      output.push("\n"); bytes += 1;
    }
  }
  return { content: output.join(""), endLine: end, nextLine: null, nextColumn: null };
}
