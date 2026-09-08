// Adapter: config backup/restore registry.
// One entry per store — adding a store means adding one entry below, so
// export and import can't drift apart. Caches are excluded on purpose:
// usage + model-catalog caches reseed themselves from the network.

import type {
  BundleStoreKey,
  ConfigBundle,
  CustomProviderDef,
  OAuthCredential,
  Profile,
  ProviderAccount,
  StoreImportResult,
  SubscriptionAccount,
  SubscriptionBackup,
} from "@swisscode/core";
import {
  BUNDLE_STORE_KEYS,
  validateAccountId,
  validateConfigBundle,
  validateCustomProviderDef,
  validateProfile,
} from "@swisscode/core";
import { defaultProviders } from "../registry.js";
import type { FileAccountRepository } from "../subscriptions/accountVault.js";
import type { FileProfileRepository } from "./fileProfiles.js";
import type { FileProviderAccountRepository } from "./providerAccounts.js";
import type { FileCustomProviderStore } from "./customProviders.js";

export interface BundleStoreDeps {
  profiles: FileProfileRepository;
  vault: FileAccountRepository;
  providerAccounts: FileProviderAccountRepository;
  customProviders: FileCustomProviderStore;
  /** Secret field keys per provider (blanked when secrets are excluded). */
  secretKeysFor: (providerId: string) => Promise<Set<string>>;
}

export interface ImportBundleOptions {
  /** True = bundled records replace same-id locals. False = keep locals. */
  overwrite: boolean;
}

function errored(store: BundleStoreKey, errors: string[]): StoreImportResult {
  return { store, imported: 0, skipped: 0, errors };
}

function isCredential(value: unknown): value is OAuthCredential {
  const rec = (value ?? {}) as Record<string, unknown>;
  return typeof rec["accessToken"] === "string" && typeof rec["refreshToken"] === "string";
}

export interface BundleRegistry {
  /** Store keys covered, in import order (customs first: accounts reference them). */
  keys(): BundleStoreKey[];
  /** Record counts per store (for the settings inventory). */
  inventory(): Promise<Record<BundleStoreKey, number>>;
  exportBundle(includeSecrets: boolean, exportedBy?: string): Promise<ConfigBundle>;
  importBundle(raw: unknown, opts: ImportBundleOptions): Promise<StoreImportResult[]>;
}

export function createBundleRegistry(deps: BundleStoreDeps): BundleRegistry {
  const builtinIds = defaultProviders().map((p) => p.id);

  async function exportBundle(includeSecrets: boolean, exportedBy?: string): Promise<ConfigBundle> {
    const profiles = await deps.profiles.list();
    const subscriptionAccounts: SubscriptionBackup[] = [];
    for (const account of await deps.vault.list()) {
      const credential = includeSecrets ? await deps.vault.loadCredential(account.id) : undefined;
      subscriptionAccounts.push(
        credential ? { account, credential } : { account },
      );
    }
    const providerAccounts = [];
    for (const a of await deps.providerAccounts.list()) {
      if (includeSecrets) {
        providerAccounts.push(a);
      } else {
        const secrets = await deps.secretKeysFor(a.providerId);
        const config: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.config)) config[k] = secrets.has(k) ? "" : v;
        providerAccounts.push({ ...a, config });
      }
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(exportedBy ? { exportedBy } : {}),
      includeSecrets,
      profiles,
      subscriptionAccounts,
      providerAccounts,
      customProviders: await deps.customProviders.list(),
    };
  }

  async function importBundle(raw: unknown, opts: ImportBundleOptions): Promise<StoreImportResult[]> {
    const { bundle, errors } = validateConfigBundle(raw);
    if (!bundle) {
      return [...BUNDLE_STORE_KEYS].map((store) => errored(store, errors));
    }
    const knownProviders = new Set([...builtinIds, ...bundle.customProviders.map((d) => d?.id)]);
    return [
      await importCustomProviders(bundle, opts),
      await importProfiles(bundle, opts),
      await importProviderAccounts(bundle, opts, knownProviders),
      await importSubscriptionAccounts(bundle, opts),
    ];
  }

  async function importCustomProviders(
    bundle: ConfigBundle,
    opts: ImportBundleOptions,
  ): Promise<StoreImportResult> {
    const res: StoreImportResult = { store: "customProviders", imported: 0, skipped: 0, errors: [] };
    for (const def of bundle.customProviders) {
      try {
        validateCustomProviderDef(def as CustomProviderDef, { reservedIds: builtinIds });
        const id = (def as CustomProviderDef).id;
        if (!opts.overwrite && (await deps.customProviders.get(id))) {
          res.skipped++;
          continue;
        }
        await deps.customProviders.save(def as CustomProviderDef, builtinIds);
        res.imported++;
      } catch (err) {
        res.errors.push(`custom provider ${(def as CustomProviderDef)?.id ?? "?"}: ${(err as Error).message}`);
      }
    }
    return res;
  }

  async function importProfiles(
    bundle: ConfigBundle,
    opts: ImportBundleOptions,
  ): Promise<StoreImportResult> {
    const res: StoreImportResult = { store: "profiles", imported: 0, skipped: 0, errors: [] };
    for (const profile of bundle.profiles) {
      try {
        validateProfile(profile as Profile);
        const name = (profile as Profile).name;
        if (!opts.overwrite && (await deps.profiles.get(name))) {
          res.skipped++;
          continue;
        }
        await deps.profiles.save(profile as Profile);
        res.imported++;
      } catch (err) {
        res.errors.push(`profile ${(profile as Profile)?.name ?? "?"}: ${(err as Error).message}`);
      }
    }
    return res;
  }

  async function importProviderAccounts(
    bundle: ConfigBundle,
    opts: ImportBundleOptions,
    knownProviders: Set<string>,
  ): Promise<StoreImportResult> {
    const res: StoreImportResult = { store: "providerAccounts", imported: 0, skipped: 0, errors: [] };
    for (const account of bundle.providerAccounts) {
      try {
        const a = account as ProviderAccount;
        validateAccountId(a.id);
        if (!knownProviders.has(a.providerId)) {
          throw new Error(`unknown provider "${a.providerId}" (import its custom definition first)`);
        }
        if (!opts.overwrite && (await deps.providerAccounts.get(a.providerId, a.id))) {
          res.skipped++;
          continue;
        }
        await deps.providerAccounts.save(a);
        res.imported++;
        const secrets = await deps.secretKeysFor(a.providerId);
        if ([...secrets].some((k) => !(a.config[k] ?? "").trim())) {
          res.errors.push(`${a.providerId}/${a.id}: saved with blank secrets — update the key after import.`);
        }
      } catch (err) {
        const a = account as ProviderAccount;
        res.errors.push(`${a?.providerId ?? "?"}/${a?.id ?? "?"}: ${(err as Error).message}`);
      }
    }
    return res;
  }

  async function importSubscriptionAccounts(
    bundle: ConfigBundle,
    opts: ImportBundleOptions,
  ): Promise<StoreImportResult> {
    const res: StoreImportResult = { store: "subscriptionAccounts", imported: 0, skipped: 0, errors: [] };
    for (const entry of bundle.subscriptionAccounts) {
      try {
        const { account, credential } = entry as SubscriptionBackup;
        validateAccountId(account.id);
        if (!credential) {
          throw new Error("no credential in bundle (exported without secrets) — log in and re-import instead");
        }
        if (!isCredential(credential)) throw new Error("credential is malformed");
        if (!opts.overwrite && (await deps.vault.get(account.id))) {
          res.skipped++;
          continue;
        }
        const now = new Date().toISOString();
        await deps.vault.save(
          {
            ...account,
            createdAt: account.createdAt || now,
            updatedAt: now,
          } as SubscriptionAccount,
          credential,
        );
        res.imported++;
      } catch (err) {
        res.errors.push(`${(entry as SubscriptionBackup)?.account?.id ?? "?"}: ${(err as Error).message}`);
      }
    }
    return res;
  }

  return {
    keys: () => ["customProviders", "profiles", "providerAccounts", "subscriptionAccounts"],
    inventory: async () => ({
      customProviders: (await deps.customProviders.list()).length,
      profiles: (await deps.profiles.list()).length,
      providerAccounts: (await deps.providerAccounts.list()).length,
      subscriptionAccounts: (await deps.vault.list()).length,
    }),
    exportBundle,
    importBundle,
  };
}
