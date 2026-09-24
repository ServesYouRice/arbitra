import type { TransportRequest, TransportResponse, TransportUsage } from "../transport-contract.js";

/**
 * Where a batch capability claim comes from. Nothing here is a verified provider
 * capability until a live run against the provider has been recorded; a driver written
 * from documentation alone stays `declared_unverified`.
 */
export interface BatchCapabilityDeclaration {
  readonly capability: "batch";
  readonly driverId: string;
  readonly transport: string;
  readonly status: "declared_unverified" | "verified_live";
  /** Public documentation the driver was written against. */
  readonly documentation: readonly string[];
  /** Redacted reference to live validation evidence. Null until live validation exists. */
  readonly liveValidation: null | { readonly recordedAt: string; readonly evidenceRef: string };
  /** How an uncertain submission can be reconciled with this provider. */
  readonly reconciliation: "metadata_listing" | "display_name_listing" | "operator_only";
}

export interface BatchItemInput {
  /** Provider-visible item identifier. Stable across restarts for the same attempt. */
  readonly customId: string;
  readonly request: TransportRequest;
}

export interface BatchSubmitInput {
  /** Client-supplied submission identity used for reconciliation where the provider supports it. */
  readonly submissionKey: string;
  readonly modelId: string;
  readonly items: readonly BatchItemInput[];
}

export type BatchLookup =
  | { readonly kind: "found"; readonly providerJobId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "inconclusive"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface BatchJobStatus {
  readonly ended: boolean;
  /** Provider's own status word, recorded verbatim. */
  readonly providerStatus: string;
  /** A whole-job failure (for example input validation) that applies to items without their own result. */
  readonly jobFailure: { readonly code: string; readonly message: string } | null;
}

export type BatchItemOutcome = "succeeded" | "errored" | "cancelled" | "expired";

export interface BatchRawItemResult {
  readonly customId: string;
  readonly outcome: BatchItemOutcome;
  /** Provider response body for a succeeded item, stored raw and parsed on delivery. */
  readonly body: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** Provider-specific batch API behind the registry. Drivers translate; the lane decides policy. */
export interface BatchDriver {
  readonly id: string;
  readonly transport: string;
  readonly declaration: BatchCapabilityDeclaration;
  submit(input: BatchSubmitInput, signal: AbortSignal): Promise<{ readonly providerJobId: string }>;
  find(submissionKey: string, modelId: string, signal: AbortSignal): Promise<BatchLookup>;
  status(providerJobId: string, signal: AbortSignal): Promise<BatchJobStatus>;
  results(providerJobId: string, signal: AbortSignal): Promise<readonly BatchRawItemResult[]>;
  cancel(providerJobId: string, signal: AbortSignal): Promise<void>;
  parse(body: unknown, request: TransportRequest): TransportResponse;
  /** Usage reported for a succeeded item, or null when the provider body carries none. */
  usage(body: unknown): TransportUsage | null;
}

/**
 * `accepted: "no"` means the provider definitely did not create billable work.
 * `accepted: "unknown"` means the request may have been accepted (lost acknowledgment,
 * timeout, 5xx). Submissions in the unknown state must never be blindly repeated.
 */
export class BatchRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly accepted: "no" | "unknown",
    readonly retryable: boolean,
  ) { super(message); this.name = "BatchRequestError"; }
}
