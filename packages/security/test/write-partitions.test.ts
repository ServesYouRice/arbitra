import { describe, expect, it } from "vitest";
import { concreteWritePath, WritePartitions } from "../src/write-partitions.js";

describe("writable executor partitions", () => {
  it("allows disjoint writers, rejects shared files across partitions and releases only the owner", () => {
    const guard = new WritePartitions([{ id: "a", paths: ["tests/a.ts", "tests/shared.ts"] }, { id: "b", paths: ["tests/b.ts", "tests/shared.ts"] }]);
    const a = guard.acquire({ taskId: "a", partitionId: "a", paths: ["tests/a.ts", "tests/shared.ts"] });
    const b = guard.acquire({ taskId: "b", partitionId: "b", paths: ["tests/b.ts"] });
    expect(guard.active()).toHaveLength(2);
    expect(() => guard.acquire({ taskId: "c", partitionId: "b", paths: ["tests/shared.ts"] })).toThrow("WRITE_SCOPE_BUSY:a");
    expect(() => guard.release({ ...a })).toThrow("STALE_OR_FORGED_WRITE_LEASE");
    guard.release(a);
    const c = guard.acquire({ taskId: "a", partitionId: "b", paths: ["tests/shared.ts"] });
    expect(() => guard.release(a)).toThrow("STALE_OR_FORGED_WRITE_LEASE");
    guard.assertGranted(c, "tests/shared.ts");
    expect(() => guard.assertGranted(c, "tests/b.ts")).toThrow("WRITE_OUTSIDE_LEASE");
    guard.release(c); guard.release(b);
    expect(guard.active()).toEqual([]);
  });

  it("serializes shared preparatory work against all writers", () => {
    const guard = new WritePartitions([{ id: "tests", paths: ["tests/a.ts", "tests/config.ts"] }]);
    const regular = guard.acquire({ taskId: "regular", partitionId: "tests", paths: ["tests/a.ts"] });
    expect(() => guard.acquire({ taskId: "setup", partitionId: "tests", paths: ["tests/config.ts"], exclusive: true })).toThrow("WRITE_SCOPE_BUSY");
    guard.release(regular);
    const setup = guard.acquire({ taskId: "setup", partitionId: "tests", paths: ["tests/config.ts"], exclusive: true });
    expect(() => guard.acquire({ taskId: "regular", partitionId: "tests", paths: ["tests/a.ts"] })).toThrow("WRITE_SCOPE_BUSY:setup");
    guard.release(setup);
  });

  it("never lets planner proposals or exclusions create write authority", () => {
    const paths = ["tests/a.ts"]; const guard = new WritePartitions([{ id: "tests", paths }]);
    paths.push("src/a.ts");
    expect(() => guard.acquire({ taskId: "a", partitionId: "tests", paths: ["src/a.ts"] })).toThrow("WRITE_SCOPE_REQUIRES_APPROVAL");
    expect(() => guard.acquire({ taskId: "a", partitionId: "tests", paths: ["tests/a.ts"], filesNotToTouch: ["tests/a.ts"] })).toThrow("WRITE_PATH_EXCLUDED");
    expect(() => guard.acquire({ taskId: "a", partitionId: "tests", paths: [] })).toThrow("EMPTY_TASK_WRITE_SCOPE");
    const lease = guard.acquire({ taskId: "a", partitionId: "tests", paths: ["tests/a.ts"] });
    expect(Object.isFrozen(lease.paths)).toBe(true);
    expect(() => guard.acquire({ taskId: "a", partitionId: "tests", paths: ["tests/a.ts"] })).toThrow("WRITE_TASK_ALREADY_ACTIVE_OR_INVALID");
  });

  it("rejects case aliases and file/parent collisions before dispatch", () => {
    expect(() => new WritePartitions([{ id: "tests", paths: ["tests/a.ts", "tests/A.ts"] }])).toThrow("DUPLICATE_WRITE_PATH");
    expect(() => new WritePartitions([{ id: "tests", paths: ["tests/a", "tests/a/b.ts"] }])).toThrow("WRITE_PATH_ANCESTOR_CONFLICT");
    const guard = new WritePartitions([{ id: "a", paths: ["tests/a"] }, { id: "b", paths: ["tests/A/b.ts"] }]);
    guard.acquire({ taskId: "a", partitionId: "a", paths: ["tests/a"] });
    expect(() => guard.acquire({ taskId: "b", partitionId: "b", paths: ["tests/A/b.ts"] })).toThrow("WRITE_SCOPE_BUSY");
    expect(() => guard.acquire({ taskId: "b", partitionId: "a", paths: ["tests/A"] })).toThrow("WRITE_SCOPE_REQUIRES_APPROVAL");
  });

  it.each(["", "/test/a.ts", "../a.ts", "tests/../a.ts", "tests//a.ts", "tests\\a.ts", "tests/*.ts", "tests/a.ts:stream", "tests/a.ts.", "tests/NUL.ts", "tests/COM1", ".git/config", "tests/.codex/config", "tests/a\u0000.ts"])("rejects ambiguous or control-plane write path %j", (path) => {
    expect(() => concreteWritePath(path)).toThrow();
  });
});
