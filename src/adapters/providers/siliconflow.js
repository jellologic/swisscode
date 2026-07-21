/** @type {import('../../ports/provider.js').ProviderDescriptor} */
export const siliconflow = {
  id: 'siliconflow',
  label: 'SiliconFlow (硅基流动)',
  // BARE HOST, no trailing slash and no /v1 — `.../v1` produces
  // /v1/v1/messages and a 404. Mainland accounts use api.siliconflow.cn;
  // override per profile or with --cc-base-url.
  baseUrl: 'https://api.siliconflow.com',
  // ANTHROPIC_AUTH_TOKEN rather than ANTHROPIC_API_KEY: the latter triggers
  // Claude Code's one-time interactive approval prompt.
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: {},
  catalogId: null,
  hints: {
    keyHint: 'sk-… token from siliconflow.com (or .cn for mainland accounts)',
    modelHint: 'a Pro/ prefix selects the paid variant; unprefixed is the free tier',
    note: 'Mainland accounts: set the base URL to https://api.siliconflow.cn',
  },
}
