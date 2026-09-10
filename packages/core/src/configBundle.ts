// Config backup/restore: one versioned bundle covering every swisscode store.
// The bundle is the registry — each key maps to exactly one store, so export
// and import can't silently drift apart. Caches (usage, model catalog) are
// deliberately excluded: they reseed themselves.

import type { GlobalSettings, Profile } from "./domain.js";
import type {
  OAuthCredential,
  ProviderAccount,
  SubscriptionAccount,
} from "./subscriptions.js";
import type { CustomProviderDef } from "./customProviders.js";
import { isGlobalSettingsShape } from "./shapes.js";

/** Bump when the bundle shape changes; imports reject newer majors. */
export const CONFIG_BUNDLE_VERSION = 1;

export interface SubscriptionBackup {
  account: SubscriptionAccount;
  /** Absent when exported with secrets excluded — re-import after login. */
  credential?: OAuthCredential;
}

export interface ConfigBundle {
  version: number;
  exportedAt: string;
  exportedBy?: string;
  /** False = secrets were stripped; restores need keys/logins again. */
  includeSecrets: boolean;
  profiles: Profile[];
  subscriptionAccounts: SubscriptionBackup[];
  providerAccounts: ProviderAccount[];
  customProviders: CustomProviderDef[];
  /**
   * Global runtime settings (single record, not a list). Optional so bundles
   * exported before settings existed still import onto the defaults.
   */
  settings?: GlobalSettings;
}

/** Every store key the bundle covers. Add a store = add a key here. */
export const BUNDLE_STORE_KEYS = [
  "profiles",
  "subscriptionAccounts",
  "providerAccounts",
  "customProviders",
  "settings",
] as const;

export type BundleStoreKey = (typeof BUNDLE_STORE_KEYS)[number];

export interface StoreImportResult {
  store: BundleStoreKey;
  imported: number;
  /** Already present and overwrite was off. */
  skipped: number;
  errors: string[];
}

/** Shape-check an unknown payload. Records are validated per-store on import. */
export function validateConfigBundle(raw: unknown): { bundle?: ConfigBundle; errors: string[] } {
  if (!raw || typeof raw !== "object") return { errors: ["Bundle must be a JSON object."] };
  const rec = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (rec["version"] !== CONFIG_BUNDLE_VERSION) {
    errors.push(
      `Unsupported bundle version ${JSON.stringify(rec["version"])} (this swisscode reads v${CONFIG_BUNDLE_VERSION}). Export with a matching version.`,
    );
  }
  if (typeof rec["includeSecrets"] !== "boolean") errors.push("Bundle needs includeSecrets true/false.");
  for (const key of BUNDLE_STORE_KEYS) {
    // "settings" is one record, not a list — checked below, not here.
    if (key === "settings") continue;
    if (!Array.isArray(rec[key])) errors.push(`Bundle needs a "${key}" list.`);
  }
  if (rec["settings"] !== undefined && !isGlobalSettingsShape(rec["settings"])) {
    errors.push(`Bundle "settings" must be { rotationEnabled, rotationStrategy }.`);
  }
  if (errors.length > 0) return { errors };
  return { bundle: raw as ConfigBundle, errors: [] };
}
