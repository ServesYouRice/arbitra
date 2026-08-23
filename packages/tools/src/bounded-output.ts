import { createHash } from "node:crypto";

export interface ArtifactSink {
  put(content: string): Promise<string>;
}

export interface BoundedOutput {
  readonly summary: string;
  readonly preview: string;
  readonly artifact: string | null;
  readonly truncated: boolean;
  readonly trust: "untrusted";
  readonly originalBytes: number;
}

export class MemoryArtifactSink implements ArtifactSink {
  readonly values = new Map<string, string>();
  async put(content: string): Promise<string> {
    const ref = `artifacts/${createHash("sha256").update(content).digest("hex")}.txt`;
    this.values.set(ref, content);
    return ref;
  }
}

export class NodeByteBudget {
  private readonly used = new Map<string, number>();
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("INVALID_NODE_BYTE_BUDGET");
  }
  consume(nodeId: string, bytes: number): void {
    const next = (this.used.get(nodeId) ?? 0) + bytes;
    if (next > this.limit) {
      throw new Error(`NODE_BYTE_BUDGET_EXCEEDED: node ${nodeId} has ${this.remaining(nodeId)} bytes remaining; narrow the path, line range, or search query.`);
    }
    this.used.set(nodeId, next);
  }
  remaining(nodeId: string): number { return Math.max(0, this.limit - (this.used.get(nodeId) ?? 0)); }
}

export async function boundOutput(
  content: string,
  maximumBytes: number,
  summary: string,
  artifacts: ArtifactSink,
): Promise<BoundedOutput> {
  const originalBytes = Buffer.byteLength(content);
  if (originalBytes <= maximumBytes) {
    return Object.freeze({ summary, preview: content, artifact: null, truncated: false, trust: "untrusted", originalBytes });
  }
  const preview = truncateUtf8(content, maximumBytes);
  return Object.freeze({
    summary,
    preview,
    artifact: await artifacts.put(content),
    truncated: true,
    trust: "untrusted",
    originalBytes,
  });
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
}
