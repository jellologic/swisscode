// Adapter: config backup/restore registry.
// One entry per store — adding a store means adding one entry below, so
// export and import can't drift apart. Caches are excluded on purpose:
// usage + model-catalog caches reseed themselves from the network.

import type {
  BundleStoreKey,
  ConfigBundle,
  CustomProviderDef,
  Profile,
  ProviderAccount,
  StoreImportResult,
  SubscriptionAccount,
  SubscriptionBackup,
} from "@swisscode/core";
import {
  BUNDLE_STORE_KEYS,
  blankSecretValues,
  isGlobalSettingsShape,
  isProfileShape,
  isSecretConfigKey,
  isProviderAccountShape,
  isSubscriptionBackupShape,
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
import type { FileSettingsStore } from "./fileSettings.js";

export interface BundleStoreDeps {
  profiles: FileProfileRepository;
  vault: FileAccountRepository;
  providerAccounts: FileProviderAccountRepository;
  customProviders: FileCustomProviderStore;
  settings: FileSettingsStore;
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

/**
 * An exported bundle states, in the file itself, whether it was stripped —
 * "includeSecrets: false" describes the request, this describes the result, so
 * a bundle can never again claim to be safe to share while carrying a key.
 */
export interface ExportedConfigBundle extends ConfigBundle {
  secretsStripped: boolean;
}

export interface BundleRegistry {
  /** Store keys covered, in import order (customs first: accounts reference them). */
  keys(): BundleStoreKey[];
  /** Record counts per store (for the settings inventory). */
  inventory(): Promise<Record<BundleStoreKey, number>>;
  exportBundle(includeSecrets: boolean, exportedBy?: string): Promise<ExportedConfigBundle>;
  importBundle(raw: unknown, opts: ImportBundleOptions): Promise<StoreImportResult[]>;
}

export function createBundleRegistry(deps: BundleStoreDeps): BundleRegistry {
  const builtinIds = defaultProviders().map((p) => p.id);

  /**
   * Build the "is this config key a secret?" test for one export run.
   *
   * A provider we can resolve answers exactly (its `secret: true` fields). A
   * provider we cannot — its definition was deleted, or the profile names a
   * provider this machine never had — has no field list to consult, so fall
   * back to the name pattern the launch redaction uses: a blanked non-secret
   * costs the user a retype, an exported key costs them the key.
   */
  function secretKeyTest(
    customIds: string[],
  ): (providerId: string) => Promise<(key: string) => boolean> {
    const known = new Set([...builtinIds, ...customIds]);
    const cache = new Map<string, (key: string) => boolean>();
    return async (providerId: string) => {
      const hit = cache.get(providerId);
      if (hit) return hit;
      const secrets = await deps.secretKeysFor(providerId);
      const test = known.has(providerId)
        ? (key: string) => secrets.has(key)
        : (key: string) => isSecretConfigKey(key, secrets);
      cache.set(providerId, test);
      return test;
    };
  }

  async function exportBundle(
    includeSecrets: boolean,
    exportedBy?: string,
  ): Promise<ExportedConfigBundle> {
    const customProviders = await deps.customProviders.list();
    const isSecretKey = secretKeyTest(customProviders.map((d) => d.id));
    const profiles = [];
    for (const p of await deps.profiles.list()) {
      profiles.push(includeSecrets ? p : await blankProfileSecrets(p, isSecretKey));
    }
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
        const isSecret = await isSecretKey(a.providerId);
        providerAccounts.push({ ...a, config: blankSecretValues(a.config, isSecret) });
      }
    }
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(exportedBy ? { exportedBy } : {}),
      includeSecrets,
      secretsStripped: !includeSecrets,
      profiles,
      subscriptionAccounts,
      providerAccounts,
      customProviders: includeSecrets ? customProviders : customProviders.map(blankEnvStatic),
      settings: await deps.settings.get(),
    };
  }

  /**
   * A profile's inline `providerConfig` overrides the stored account, so it is
   * a second, easily forgotten home for an API key — the export used to ship it
   * verbatim under a "secrets excluded" label.
   */
  async function blankProfileSecrets(
    profile: Profile,
    isSecretKey: (providerId: string) => Promise<(key: string) => boolean>,
  ): Promise<Profile> {
    const config = profile.providerConfig;
    if (!config || Object.keys(config).length === 0) return profile;
    const isSecret = await isSecretKey(profile.providerId);
    return { ...profile, providerConfig: blankSecretValues(config, isSecret) };
  }

  /** `envStatic` values are free text a user may have pasted a token into. */
  function blankEnvStatic(def: CustomProviderDef): CustomProviderDef {
    if (!def.envStatic || Object.keys(def.envStatic).length === 0) return def;
    // Every value, not just the secret-looking ones: envStatic is free text and
    // there is no field declaration to consult.
    return { ...def, envStatic: blankSecretValues(def.envStatic, () => true) };
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
      await importSettings(bundle, opts),
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
        // Shape first: validateProfile only inspects three strings, so a
        // nested-object providerConfig would reach disk and break the launch
        // path and every page that renders it.
        if (!isProfileShape(profile)) throw new Error("malformed record (wrong field types)");
        validateProfile(profile);
        if (!opts.overwrite && (await deps.profiles.get(profile.name))) {
          res.skipped++;
          continue;
        }
        await deps.profiles.save(profile);
        res.imported++;
        // A bundle is an untrusted document: agentArgs land on the agent's
        // command line, so name them instead of importing flags in silence.
        if (profile.agentArgs?.length) {
          res.errors.push(
            `profile ${profile.name}: imported agent args ${JSON.stringify(profile.agentArgs)} — review before launching.`,
          );
        }
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
        // The whole point of item 16: a record without a `config` object used
        // to save cleanly here and then throw from `Object.entries(a.config)`
        // on four unrelated pages.
        if (!isProviderAccountShape(account)) {
          throw new Error("malformed record (needs id, providerId, label and a flat config object)");
        }
        const a = account;
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
        // Shape-check the pair before touching the vault: a bad entry is one
        // reported record, not a poisoned account file.
        if (!isSubscriptionBackupShape(entry)) {
          throw new Error("malformed record (needs an account, and a credential with both tokens)");
        }
        const { account, credential } = entry;
        validateAccountId(account.id);
        if (!credential) {
          throw new Error("no credential in bundle (exported without secrets) — log in and re-import instead");
        }
        if (!opts.overwrite && (await deps.vault.get(account.id))) {
          res.skipped++;
          continue;
        }
        const now = new Date().toISOString();
        const stored: SubscriptionAccount = {
          ...account,
          createdAt: account.createdAt || now,
          updatedAt: now,
        };
        await deps.vault.save(stored, credential);
        res.imported++;
      } catch (err) {
        res.errors.push(`${(entry as SubscriptionBackup)?.account?.id ?? "?"}: ${(err as Error).message}`);
      }
    }
    return res;
  }

  /**
   * One record, not a list: absent means "exported before settings existed" and
   * imports onto the defaults (no version bump). With overwrite off, a present
   * local file wins — the toggle is the user's live choice, not import data.
   */
  async function importSettings(
    bundle: ConfigBundle,
    opts: ImportBundleOptions,
  ): Promise<StoreImportResult> {
    const res: StoreImportResult = { store: "settings", imported: 0, skipped: 0, errors: [] };
    if (bundle.settings === undefined) return res;
    if (!isGlobalSettingsShape(bundle.settings)) {
      res.errors.push("settings: malformed record (needs rotationEnabled and rotationStrategy)");
      return res;
    }
    if (!opts.overwrite && (await deps.settings.present())) {
      res.skipped++;
      return res;
    }
    await deps.settings.save(bundle.settings);
    res.imported++;
    return res;
  }

  return {
    keys: () => ["customProviders", "profiles", "providerAccounts", "subscriptionAccounts", "settings"],
    inventory: async () => ({
      customProviders: (await deps.customProviders.list()).length,
      profiles: (await deps.profiles.list()).length,
      providerAccounts: (await deps.providerAccounts.list()).length,
      subscriptionAccounts: (await deps.vault.list()).length,
      settings: (await deps.settings.present()) ? 1 : 0,
    }),
    exportBundle,
    importBundle,
  };
}
