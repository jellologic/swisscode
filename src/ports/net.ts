// Port: one HTTP GET returning JSON.
//
// One method. No retries, no interceptors, no middleware, no RequestBuilder.
// Constructed only inside catalog wiring — it never appears on the launch path.

export type NetGetJsonOptions = {
  timeoutMs?: number
  headers?: Record<string, string>
}

export type NetPort = {
  /**
   * Rejects on transport error or non-2xx.
   *
   * Returns `unknown`, deliberately. This is parsed JSON from a third party:
   * every catalog adapter runs it through its own `normalize` and then through
   * core/catalog.ts `sanitizeModels`, and `unknown` is what forces that. Typing
   * it `any` would let an unvalidated field flow all the way into
   * ANTHROPIC_DEFAULT_*_MODEL without a single diagnostic.
   */
  getJson: (url: string, opts?: NetGetJsonOptions) => Promise<unknown>
}

export {}
