declare const turnStateBrand: unique symbol;
declare const sessionStateBrand: unique symbol;

/** Transport-local only; it is intentionally incompatible with persisted session state. */
export interface TurnContinuationState {
  readonly opaque: string | Uint8Array;
  readonly [turnStateBrand]: true;
}

export interface SessionContinuationState {
  readonly transport: string;
  readonly modelId: string;
  readonly activityId: string;
  readonly opaque: string | Uint8Array;
  readonly expiresAt: number | null;
  readonly [sessionStateBrand]: true;
}

export function sessionContinuationState(value: Omit<SessionContinuationState, typeof sessionStateBrand>): SessionContinuationState {
  return Object.freeze({ ...value }) as SessionContinuationState;
}

export interface ContinuationTrace {
  readonly hash: string;
  readonly byteLength: number;
  readonly scope: "session";
  readonly provider: string;
  readonly model: string;
}
