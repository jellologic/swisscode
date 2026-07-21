// Port: a browsable model catalog.
//
// The whole reason this port exists is that catalogs disagree about what they
// publish. OpenRouter publishes prices, benchmarks and per-model parameter
// lists. ModelScope publishes an OpenAI-style id list and nothing else. A port
// that pretended otherwise would render "$0.00 / free" for models whose price
// is simply unknown, which is worse than rendering nothing.
//
// Two things carry that weight and neither may be collapsed:
//   1. `tools` is TRI-STATE. null means UNKNOWN, false means CONFIRMED ABSENT.
//   2. `capabilities` is declared up front, so the UI branches on a stated fact
//      rather than sniffing nulls out of the rows.

/**
 * Per-token prices in USD. Not per million — core/format.js scales for display.
 *
 * @typedef {Object} Pricing
 * @property {number} prompt
 * @property {number} completion
 * @property {number|null} cacheRead  null = provider does no prompt caching
 */

/**
 * @typedef {Object} Benchmarks
 * @property {number|null} intelligence
 * @property {number|null} coding
 * @property {number|null} agentic
 */

/**
 * @typedef {Object} NormalizedModel
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number|null} context
 * @property {number|null} maxOutput
 * @property {Pricing|null}    pricing     null = catalog publishes none
 * @property {Benchmarks|null} benchmarks  null = catalog publishes none
 * @property {boolean|null}    tools       TRI-STATE. null = UNKNOWN.
 * @property {boolean|null}    reasoning
 * @property {boolean}         [extendedContext]
 */

/**
 * @typedef {Object} CatalogCapabilities
 * @property {boolean} pricing
 * @property {boolean} benchmarks
 * @property {boolean} toolSupportKnown  false => `tools` is null for all rows
 *                                       except hand-confirmed deny-list entries
 * @property {boolean} requiresAuth
 */

/**
 * @typedef {Object} CatalogResult
 * @property {NormalizedModel[]} models
 * @property {boolean} fromCache
 * @property {boolean} stale
 * @property {string|null} error
 */

/**
 * `list()` NEVER throws. An offline box with a warm cache still gets a working
 * picker; a cold one gets an empty list plus an error string to display.
 *
 * @typedef {Object} ModelCatalogPort
 * @property {string} id
 * @property {string} label
 * @property {CatalogCapabilities} capabilities
 * @property {(opts?:{force?:boolean}) => Promise<CatalogResult>} list
 */

export {}
