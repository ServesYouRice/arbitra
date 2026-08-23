export type FakeTransportStep<TResponse> =
  | { readonly type: "response"; readonly value: TResponse }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "wait"; readonly value: TResponse };

/** Generic and dependency-free so every provider contract suite can reuse it. */
export class ScriptedFakeTransport<TRequest, TResponse> {
  readonly requests: TRequest[] = [];
  private cursor = 0;
  constructor(private readonly steps: readonly FakeTransportStep<TResponse>[]) {}

  async send(request: TRequest, signal: AbortSignal): Promise<TResponse> {
    this.requests.push(request);
    const step = this.steps[this.cursor];
    this.cursor += 1;
    if (step === undefined) throw new Error("FAKE_TRANSPORT_SCRIPT_EXHAUSTED");
    if (signal.aborted) throw abortError();
    if (step.type === "error") throw step.error;
    if (step.type === "wait") {
      await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true }));
    }
    return step.value;
  }
}

function abortError(): Error {
  const error = new Error("Fake transport request cancelled");
  error.name = "AbortError";
  return error;
}
