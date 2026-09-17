import { z } from "zod";
import { boardOperationSchema } from "./board-operation.js";
import { findingLocationSchema, sourceFindingSchema } from "./finding.js";

/** Local IDs are rebound to authoritative run/reviewer identities by the runtime. */
export const peerOperationsResultSchema = z.object({
  operations: z.array(boardOperationSchema).max(100),
  locations: z.array(findingLocationSchema).max(100),
  findings: z.array(sourceFindingSchema).max(20),
}).strict();
export type PeerOperationsResult = z.infer<typeof peerOperationsResultSchema>;
