// Port: persistence for ~/.config/cuckoocode/config.json.
//
// SYNCHRONOUS on purpose. It is one small local file, and the launch path
// should not pay for an await + microtask turn to read it.

/**
 * @typedef {Object} Profile
 * @property {string} provider              id from the provider registry
 * @property {string} [label]
 * @property {string} [baseUrl]
 * @property {string} [apiKey]              inline; the file is 0600
 * @property {string} [apiKeyFromEnv]       read from the ambient env instead
 * @property {Partial<Record<string,string>>} [models]  '' means UNSET the tier
 * @property {boolean} [skipPermissions]
 * @property {Record<string,string>} [env]  '' means UNSET the variable
 * @property {import('./provider.js').CompatFlags} [compat]  overrides the
 *   provider's gateway compatibility defaults, key by key. `false` here is an
 *   explicit "off" and clears the variable; omit a key to accept the default.
 * @property {Record<string,number>} [contextWindows]  bare model id -> real
 *   context length in tokens, captured from a catalog when the model was
 *   picked. Used to set the auto-compact window. A model absent from this map
 *   and from the provider's extendedContext is UNKNOWN and never guessed at.
 */

/**
 * @typedef {Object} State
 * @property {number} version
 * @property {Record<string,Profile>} profiles
 * @property {string|null} defaultProfile
 * @property {Record<string,string|{profile:string,overrides?:object}>} bindings
 * @property {{quiet?:boolean, bindingWalkDepth?:number}} settings
 */

/**
 * @typedef {Object} LoadResult
 * @property {State}   state
 * @property {boolean} corrupt   file existed but could not be understood
 * @property {boolean} readOnly  file is a NEWER schema; writes are refused
 * @property {boolean} migrated  the shape changed on load
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} ConfigStorePort
 * @property {() => LoadResult} load
 * @property {(state:State) => string} save  returns path; throws if readOnly
 * @property {() => string} path
 */

export {}
