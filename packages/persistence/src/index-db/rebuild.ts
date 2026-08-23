import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "../canonical-json.js";
import { loadActivityTraces } from "../trace.js";

export interface RebuildResult { readonly indexPath: string; readonly traceCount: number; readonly runCount: number; }

/** Replaces only the derived SQLite projection; JSONL run traces remain authoritative. */
export async function rebuildIndex(runsDirectory: string): Promise<RebuildResult> {
  const indexPath = join(runsDirectory, "index.db");
  await mkdir(runsDirectory, { recursive: true });
  await rm(indexPath, { force: true });
  const database = new DatabaseSync(indexPath);
  try {
    database.exec(`
      CREATE TABLE model_activity_traces (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        model_identity TEXT NOT NULL,
        harness_identity TEXT NOT NULL,
        protocol_identity TEXT NOT NULL,
        outcome TEXT NOT NULL,
        trace_json TEXT NOT NULL,
        PRIMARY KEY (run_id, activity_id, attempt)
      ) STRICT;
      CREATE INDEX trace_outcome_idx ON model_activity_traces(outcome);
      CREATE INDEX trace_identity_idx ON model_activity_traces(model_identity, harness_identity, protocol_identity);
    `);
    const insert = database.prepare(`INSERT INTO model_activity_traces
      (run_id,node_id,activity_id,attempt,model_identity,harness_identity,protocol_identity,outcome,trace_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    let traceCount = 0; let runCount = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
        const traces = await loadActivityTraces(runsDirectory, entry.name);
        if (traces.length > 0) runCount += 1;
        for (const trace of traces) {
          insert.run(trace.runId, trace.nodeId, trace.activityId, trace.attempt,
            modelIdentity(trace), harnessIdentity(trace), protocolIdentity(trace), trace.outcome, canonicalJson(trace));
          traceCount += 1;
        }
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return Object.freeze({ indexPath, traceCount, runCount });
  } finally { database.close(); }
}

export function modelIdentity(trace: { readonly modelId: string; readonly modelProfileVersion: string;
  readonly transportId: string; readonly transportVersion: string }): string {
  return canonicalJson([trace.modelId, trace.modelProfileVersion, trace.transportId, trace.transportVersion]);
}
export function harnessIdentity(trace: { readonly harnessId: string; readonly harnessVersion: string; readonly harnessPolicyHash: string }): string {
  return canonicalJson([trace.harnessId, trace.harnessVersion, trace.harnessPolicyHash]);
}
export function protocolIdentity(trace: { readonly protocolId: string; readonly protocolVersion: string; readonly protocolHash: string }): string {
  return canonicalJson([trace.protocolId, trace.protocolVersion, trace.protocolHash]);
}
