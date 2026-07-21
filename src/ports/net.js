// Port: one HTTP GET returning JSON.
//
// One method. No retries, no interceptors, no middleware, no RequestBuilder.
// Constructed only inside catalog wiring — it never appears on the launch path.

/**
 * @typedef {Object} NetPort
 * @property {(url:string, opts?:{timeoutMs?:number, headers?:Record<string,string>})
 *            => Promise<unknown>} getJson  rejects on transport or non-2xx
 */

export {}
