// Adapter: user-defined provider, interpreted from a CustomProviderDef.
// Same ProviderPort shape as built-ins, so customs flow through accounts,
// profiles, launches, and /help with no special cases. Unknown capabilities
// (usage readers, model catalogs, login import) stay off: customs are
// env-mapping providers only.

import type { CustomProviderDef, ProviderPort } from "@swisscode/core";

export function customProviderPort(def: CustomProviderDef): ProviderPort {
  return {
    id: def.id,
    displayName: def.displayName,
    description: def.description ?? "",
    fields: def.fields,
    accountCapabilities: {
      importActive: false,
      usageMetrics: false,
      switchVia: [],
      ...(def.hint ? { hint: def.hint } : {}),
    },
    buildEnv(
      config: Record<string, string> | undefined,
      profile: { model?: string },
    ): Record<string, string> {
      const env: Record<string, string> = { ...(def.envStatic ?? {}) };
      for (const [envVar, fieldKey] of Object.entries(def.envFromConfig ?? {})) {
        const value = (config?.[fieldKey] ?? "").trim();
        if (value) env[envVar] = value;
      }
      if (def.modelEnvVar) {
        const fallbackKey = def.modelConfigKey ?? "model";
        const model =
          (profile.model ?? "").trim() || (config?.[fallbackKey] ?? "").trim();
        if (model) env[def.modelEnvVar] = model;
      }
      return env;
    },
    ...(def.help ? { help: def.help } : {}),
  };
}
