export class RunCancellation {
  readonly #controller = new AbortController();
  #reason: string | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  cancel(reason = "Cancelled by user"): void {
    if (this.cancelled) return;
    this.#reason = reason;
    this.#controller.abort(reason);
  }
}

