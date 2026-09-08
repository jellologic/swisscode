import { createServerFn } from "@tanstack/react-start";
import type { Profile } from "@swisscode/core";
import {
  deleteProfile,
  exportConfigBundle,
  getAccounts,
  getAgents,
  getBundleInventory,
  getCurrentLogin,
  getProfiles,
  getProviderModelEndpoints,
  getProviderModels,
  getProviderUsage,
  getProviders,
  clearProxyTraffic,
  getProxyState,
  getProxyTraffic,
  getSessionContext,
  getUsage,
  importConfigBundle,
  validateProviderAccount,
  importAccount,
  listProviderAccountSummaries,
  previewProfile,
  removeAccount,
  removeCustomProvider,
  removeProviderAccount,
  renameSubscriptionAccount,
  saveCustomProvider,
  saveProfile,
  saveProviderAccount,
  setProxyTrafficSize,
  storePath,
  switchSubscriptionAccount,
  updateProviderAccount,
  useProxyAccount,
} from "./store.server";

export const listProfilesFn = createServerFn({ method: "GET" }).handler(async () => ({
  profiles: await getProfiles(),
  storePath: storePath(),
}));

export const catalogFn = createServerFn({ method: "GET" }).handler(async () => ({
  agents: getAgents(),
  providers: await getProviders(),
}));

export const saveProfileFn = createServerFn({ method: "POST" })
  .validator((data: Profile) => data)
  .handler(async ({ data }) => {
    await saveProfile(data);
    return { ok: true as const };
  });

export const deleteProfileFn = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => data)
  .handler(async ({ data }) => {
    await deleteProfile(data.name);
    return { ok: true as const };
  });

export const previewProfileFn = createServerFn({ method: "GET" })
  .validator((data: { name: string }) => data)
  .handler(async ({ data }) => previewProfile(data.name));

export const listAccountsFn = createServerFn({ method: "GET" }).handler(
  async () => ({ accounts: await getAccounts() }),
);

export const importAccountFn = createServerFn({ method: "POST" })
  .validator((data: { id: string; label?: string; overwrite?: boolean }) => data)
  .handler(async ({ data }) => ({ account: await importAccount(data.id, data.label, data.overwrite) }));

export const renameSubscriptionAccountFn = createServerFn({ method: "POST" })
  .validator((data: { id: string; label: string }) => data)
  .handler(async ({ data }) => {
    await renameSubscriptionAccount(data.id, data.label);
    return { ok: true as const };
  });

export const updateProviderAccountFn = createServerFn({ method: "POST" })
  .validator(
    (data: { providerId: string; id: string; label?: string; config?: Record<string, string> }) => data,
  )
  .handler(async ({ data }) => {
    await updateProviderAccount(data.providerId, data.id, { label: data.label, config: data.config });
    return { ok: true as const };
  });

export const removeAccountFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await removeAccount(data.id);
    return { ok: true as const };
  });

export const accountUsageFn = createServerFn({ method: "GET" })
  .validator((data: { ids?: string[] } = {}) => data)
  .handler(async ({ data }) => ({ results: await getUsage(data.ids) }));

export const proxyStateFn = createServerFn({ method: "GET" }).handler(
  async () => getProxyState(),
);

export const proxyUseFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await useProxyAccount(data.id);
    return { ok: true as const };
  });

export const proxyTrafficFn = createServerFn({ method: "GET" })
  .validator((data: { profile?: string } = {}) => data)
  .handler(async ({ data }) => getProxyTraffic(data.profile));

export const proxyTrafficClearFn = createServerFn({ method: "POST" }).handler(
  async () => clearProxyTraffic(),
);

export const proxyTrafficSizeFn = createServerFn({ method: "POST" })
  .validator((data: { size: number }) => data)
  .handler(async ({ data }) => setProxyTrafficSize(data.size));

export const proxySessionContextFn = createServerFn({ method: "GET" })
  .validator((data: { sessionId: string }) => data)
  .handler(async ({ data }) => ({ context: await getSessionContext(data.sessionId) }));

export const switchSubscriptionFn = createServerFn({ method: "POST" })
  .validator((data: { id: string; force?: boolean }) => data)
  .handler(async ({ data }) => switchSubscriptionAccount(data.id, data.force));

export const currentLoginFn = createServerFn({ method: "GET" }).handler(
  async () => ({ login: await getCurrentLogin() }),
);

export const listProviderAccountsFn = createServerFn({ method: "GET" })
  .validator((data: { providerId?: string } = {}) => data)
  .handler(async ({ data }) => ({ accounts: await listProviderAccountSummaries(data.providerId) }));

export const saveProviderAccountFn = createServerFn({ method: "POST" })
  .validator(
    (data: { providerId: string; id: string; label: string; config: Record<string, string> }) => data,
  )
  .handler(async ({ data }) => {
    await saveProviderAccount({
      id: data.id.trim(),
      providerId: data.providerId,
      label: data.label,
      config: data.config,
      createdAt: "",
      updatedAt: "",
    });
    return { ok: true as const };
  });

export const removeProviderAccountFn = createServerFn({ method: "POST" })
  .validator((data: { providerId: string; id: string }) => data)
  .handler(async ({ data }) => {
    await removeProviderAccount(data.providerId, data.id);
    return { ok: true as const };
  });

export const providerUsageFn = createServerFn({ method: "GET" })
  .validator((data: { providerId: string }) => data)
  .handler(async ({ data }) => ({ results: await getProviderUsage(data.providerId) }));

export const providerModelsFn = createServerFn({ method: "GET" })
  .validator((data: { providerId: string }) => data)
  .handler(async ({ data }) => getProviderModels(data.providerId));

export const providerModelEndpointsFn = createServerFn({ method: "GET" })
  .validator((data: { providerId: string; modelId: string }) => data)
  .handler(async ({ data }) => getProviderModelEndpoints(data.providerId, data.modelId));

export const saveCustomProviderFn = createServerFn({ method: "POST" })
  .validator((data: {
    id: string;
    displayName: string;
    description?: string;
    hint?: string;
    fields: { key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string }[];
    envStatic?: Record<string, string>;
    envFromConfig?: Record<string, string>;
    modelEnvVar?: string;
    modelConfigKey?: string;
    test?: {
      url: string;
      method?: "GET" | "POST";
      headerName?: string;
      authField?: string;
      authScheme?: string;
      expectStatus?: number;
    };
    help?: { summary?: string; setup?: string[]; commands?: string[]; links?: { label: string; href: string }[] };
  }) => data)
  .handler(async ({ data }) => ({
    provider: await saveCustomProvider({
      ...data,
      createdAt: "",
      updatedAt: "",
    }),
  }));

export const removeCustomProviderFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => ({ removed: await removeCustomProvider(data.id) }));

export const bundleInventoryFn = createServerFn({ method: "GET" }).handler(
  async () => getBundleInventory(),
);

export const exportBundleFn = createServerFn({ method: "GET" })
  .validator((data: { includeSecrets: boolean } = { includeSecrets: true }) => data)
  // JSON round-trip: guarantees the bundle is wire-safe (credential `extra`
  // fields are `unknown` at the type level) and satisfies the serializer.
  .handler(async ({ data }) =>
    JSON.parse(JSON.stringify(await exportConfigBundle(data.includeSecrets))),
  );

export const importBundleFn = createServerFn({ method: "POST" })
  .validator((data: { bundle: unknown; overwrite: boolean }) => data)
  .handler(async ({ data }) => ({ results: await importConfigBundle(data.bundle, data.overwrite) }));

export const validateProviderAccountFn = createServerFn({ method: "POST" })
  .validator((data: { providerId: string; config: Record<string, string> }) => data)
  .handler(async ({ data }) => validateProviderAccount(data.providerId, data.config));
