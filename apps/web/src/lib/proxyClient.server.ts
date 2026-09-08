// Server-only re-export of the shared proxy control client.
//
// The implementation lives in @swisscode/adapters (the CLI drives the same
// routes with the same messages); the `.server.` suffix keeps its node:fs
// token read out of the client bundle.

export {
  ProxyControlClient,
  ProxyUnavailableError,
  PROXY_NOT_RUNNING,
  PROXY_TOKEN_REJECTED,
} from "@swisscode/adapters";
export type {
  ProxyControlOptions,
  TrafficListResponse,
  TrafficQuery,
} from "@swisscode/adapters";
