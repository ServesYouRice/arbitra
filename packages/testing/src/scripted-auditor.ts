export type ScriptedAuditorStep<TResponse> = Readonly<
  { type: "response"; value: TResponse }
  | { type: "error"; error: Error }
>;
export interface FakeAuditor<TRequest, TResponse> {
  readonly requests: readonly TRequest[];
  readonly networkRequests: 0;
  audit(request: TRequest): Promise<TResponse>;
  remainingSteps(): number;
}

/** Offline auditor whose complete behavior is fixed by an in-memory script. */
export function scriptedAuditor<TRequest, TResponse>(script: readonly ScriptedAuditorStep<TResponse>[]): FakeAuditor<TRequest, TResponse> {
  const requests: TRequest[] = []; let cursor = 0;
  return Object.freeze({
    get requests(): readonly TRequest[] { return Object.freeze([...requests]); },
    networkRequests: 0 as const,
    async audit(request: TRequest): Promise<TResponse> { requests.push(request); const step = script[cursor++]; if (step === undefined) throw new Error("SCRIPTED_AUDITOR_EXHAUSTED"); if (step.type === "error") throw step.error; return step.value; },
    remainingSteps(): number { return script.length - cursor; },
  });
}
