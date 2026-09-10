// Server-function wrappers. Every `.validator` is a real runtime guard from
// ./validate — the payload comes over HTTP, so the declared type proves
// nothing — and it runs before the handler touches disk, Keychain or network.

import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  deleteProfile,
  exportConfigBundle,
  getAccounts,
  getAgents,
  getBundleInventory,
  getCurrentLogin,
  getGlobalSettings,
  getPresets,
  getProfiles,
  getProviderModelEndpoints,
  getProviderModels,
  getProviderUsage,
  getProviders,
  clearProxyTraffic,
  getProxyState,
  getProxyTraffic,
  getProxyTrafficEntries,
  getProxyReport,
  getSessionContext,
  getUsage,
  getUpdateStatus,
  getVersion,
  importConfigBundle,
  validateProviderAccount,
  importAccount,
  listProviderAccountSummaries,
  previewLaunch,
  previewProfile,
  removeAccount,
  removeCustomProvider,
  removeProviderAccount,
  renameSubscriptionAccount,
  saveCustomProvider,
  saveGlobalSettings,
  saveProfile,
  saveProviderAccount,
  setProxyTrafficSize,
  storePath,
  switchSubscriptionAccount,
  updateProviderAccount,
  useProxyAccount,
} from "./store.server";
import {
  parseAccountRef,
  parseAccountUsage,
  parseCustomProvider,
  parseExportBundle,
  parseGlobalSettings,
  parseImportAccount,
  parseImportBundle,
  parseModelRef,
  parseOptionalProviderRef,
  parseProfile,
  parseProfileRef,
  parseProviderAccountRef,
  parseProviderModels,
  parseProviderRef,
  parseRenameAccount,
  parseReportFilter,
  parseSaveProviderAccount,
  parseSessionRef,
  parseSwitchAccount,
  parseTrafficEntryRefs,
  parseTrafficFilter,
  parseTrafficSize,
  parseUpdateProviderAccount,
  parseValidateProviderAccount,
} from "./validate";

export const listProfilesFn = createServerFn({ method: "GET" }).handler(async () => ({
  profiles: await getProfiles(),
  storePath: storePath(),
}));

/** Running server version — feeds the Topbar badge. Never fails the page. */
export const versionFn = createServerFn({ method: "GET" }).handler(async () => getVersion());

/**
 * Update badge data from the check cache (offline-safe, never live-fetches).
 * Failure degrades to "no update", never a crash page.
 */
export const updateStatusFn = createServerFn({ method: "GET" }).handler(
  async () => getUpdateStatus(),
);

export const catalogFn = createServerFn({ method: "GET" }).handler(async () => ({
  agents: getAgents(),
  providers: await getProviders(),
}));

export const listPresetsFn = createServerFn({ method: "GET" }).handler(
  async () => getPresets(),
);

export const saveProfileFn = createServerFn({ method: "POST" })
  .validator(parseProfile)
  .handler(async ({ data }) => {
    await saveProfile(data);
    return { ok: true as const };
  });

export const deleteProfileFn = createServerFn({ method: "POST" })
  .validator(parseProfileRef)
  .handler(async ({ data }) => {
    await deleteProfile(data.name);
    return { ok: true as const };
  });

export const previewProfileFn = createServerFn({ method: "GET" })
  .validator(parseProfileRef)
  .handler(async ({ data }) => previewProfile(data.name));

/** Unsaved-form preview: the whole profile goes up, the launch JSON comes back. */
export const previewLaunchFn = createServerFn({ method: "POST" })
  .validator(parseProfile)
  .handler(async ({ data }) => previewLaunch(data));

export const listAccountsFn = createServerFn({ method: "GET" }).handler(
  async () => ({ accounts: await getAccounts() }),
);

export const importAccountFn = createServerFn({ method: "POST" })
  .validator(parseImportAccount)
  .handler(async ({ data }) => ({ account: await importAccount(data.id, data.label, data.overwrite) }));

export const renameSubscriptionAccountFn = createServerFn({ method: "POST" })
  .validator(parseRenameAccount)
  .handler(async ({ data }) => {
    await renameSubscriptionAccount(data.id, data.label);
    return { ok: true as const };
  });

export const updateProviderAccountFn = createServerFn({ method: "POST" })
  .validator(parseUpdateProviderAccount)
  .handler(async ({ data }) => {
    await updateProviderAccount(data.providerId, data.id, { label: data.label, config: data.config });
    return { ok: true as const };
  });

export const removeAccountFn = createServerFn({ method: "POST" })
  .validator(parseAccountRef)
  .handler(async ({ data }) => {
    await removeAccount(data.id);
    return { ok: true as const };
  });

export const accountUsageFn = createServerFn({ method: "GET" })
  .validator(parseAccountUsage)
  .handler(async ({ data }) => ({ results: await getUsage(data.ids) }));

export const proxyStateFn = createServerFn({ method: "GET" }).handler(
  async () => getProxyState(),
);

export const proxyUseFn = createServerFn({ method: "POST" })
  .validator(parseAccountRef)
  .handler(async ({ data }) => {
    await useProxyAccount(data.id);
    return { ok: true as const };
  });

export const proxyTrafficFn = createServerFn({ method: "GET" })
  .validator(parseTrafficFilter)
  .handler(async ({ data }) => getProxyTraffic(data.profile));

/** Bodies for the entries a page actually renders (the list ships none). */
export const proxyTrafficEntriesFn = createServerFn({ method: "GET" })
  .validator(parseTrafficEntryRefs)
  .handler(async ({ data }) => ({ entries: await getProxyTrafficEntries(data.ids) }));

/** Store-backed history (survives proxy restarts); null-safe when no store yet. */
export const proxyReportFn = createServerFn({ method: "GET" })
  .validator(parseReportFilter)
  .handler(async ({ data }) => getProxyReport(data));

export const proxyTrafficClearFn = createServerFn({ method: "POST" }).handler(
  async () => clearProxyTraffic(),
);

export const proxyTrafficSizeFn = createServerFn({ method: "POST" })
  .validator(parseTrafficSize)
  .handler(async ({ data }) => setProxyTrafficSize(data.size));

export const proxySessionContextFn = createServerFn({ method: "GET" })
  .validator(parseSessionRef)
  .handler(async ({ data }) => ({ context: await getSessionContext(data.sessionId) }));

export const switchSubscriptionFn = createServerFn({ method: "POST" })
  .validator(parseSwitchAccount)
  .handler(async ({ data }) => switchSubscriptionAccount(data.id, data.force));

export const currentLoginFn = createServerFn({ method: "GET" }).handler(
  async () => ({ login: await getCurrentLogin() }),
);

export const listProviderAccountsFn = createServerFn({ method: "GET" })
  .validator(parseOptionalProviderRef)
  .handler(async ({ data }) => ({ accounts: await listProviderAccountSummaries(data.providerId) }));

export const saveProviderAccountFn = createServerFn({ method: "POST" })
  .validator(parseSaveProviderAccount)
  .handler(async ({ data }) => {
    await saveProviderAccount({
      id: data.id,
      providerId: data.providerId,
      label: data.label,
      config: data.config,
      createdAt: "",
      updatedAt: "",
    });
    return { ok: true as const };
  });

export const removeProviderAccountFn = createServerFn({ method: "POST" })
  .validator(parseProviderAccountRef)
  .handler(async ({ data }) => {
    await removeProviderAccount(data.providerId, data.id);
    return { ok: true as const };
  });

export const providerUsageFn = createServerFn({ method: "GET" })
  .validator(parseProviderRef)
  .handler(async ({ data }) => ({ results: await getProviderUsage(data.providerId) }));

export const providerModelsFn = createServerFn({ method: "GET" })
  .validator(parseProviderModels)
  .handler(async ({ data }) => getProviderModels(data.providerId, data.accountId));

export const providerModelEndpointsFn = createServerFn({ method: "GET" })
  .validator(parseModelRef)
  .handler(async ({ data }) => getProviderModelEndpoints(data.providerId, data.modelId));

export const saveCustomProviderFn = createServerFn({ method: "POST" })
  .validator(parseCustomProvider)
  .handler(async ({ data }) => ({
    provider: await saveCustomProvider({
      ...data,
      createdAt: "",
      updatedAt: "",
    }),
  }));

export const removeCustomProviderFn = createServerFn({ method: "POST" })
  .validator(parseAccountRef)
  .handler(async ({ data }) => ({ removed: await removeCustomProvider(data.id) }));

export const bundleInventoryFn = createServerFn({ method: "GET" }).handler(
  async () => getBundleInventory(),
);

/**
 * POST, not GET: a bundle can carry every OAuth token and API key on the
 * machine, and secrets ship only when this request asks for them. no-store
 * keeps that body out of any cache between here and the browser.
 */
export const exportBundleFn = createServerFn({ method: "POST" })
  .validator(parseExportBundle)
  // JSON round-trip: guarantees the bundle is wire-safe (credential `extra`
  // fields are `unknown` at the type level) and satisfies the serializer.
  .handler(async ({ data }) => {
    setResponseHeader("cache-control", "no-store");
    return JSON.parse(JSON.stringify(await exportConfigBundle(data.includeSecrets)));
  });

export const importBundleFn = createServerFn({ method: "POST" })
  .validator(parseImportBundle)
  .handler(async ({ data }) => ({ results: await importConfigBundle(data.bundle, data.overwrite) }));

export const validateProviderAccountFn = createServerFn({ method: "POST" })
  .validator(parseValidateProviderAccount)
  .handler(async ({ data }) => validateProviderAccount(data.providerId, data.config));

export const getGlobalSettingsFn = createServerFn({ method: "GET" }).handler(
  async () => ({ settings: await getGlobalSettings() }),
);

export const saveGlobalSettingsFn = createServerFn({ method: "POST" })
  .validator(parseGlobalSettings)
  .handler(async ({ data }) => {
    await saveGlobalSettings(data);
    return { ok: true as const };
  });
