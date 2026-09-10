// Generic provider accounts: `swisscode accounts --provider <id> ...`
// Key-based providers (OpenRouter, Meta). Secrets are never printed —
// show masks them, usage reads them server-side only.

import {
  CachingModelCatalog,
  FileCustomProviderStore,
  FileModelCatalogCache,
  FileProviderAccountRepository,
  MetaModelCatalog,
  OpenRouterModelCatalog,
  OpenRouterUsageReader,
  createProviderRegistry,
  loadCustomProviderPorts,
  maskSecret,
} from "@swisscode/adapters";
import type { ProviderAccount, ProviderUsageReader } from "@swisscode/core";

const store = new FileProviderAccountRepository();
const usageReaders: ProviderUsageReader[] = [new OpenRouterUsageReader()];

/** Registry = built-ins + stored customs (cached per process). */
let registryPromise: Promise<ReturnType<typeof createProviderRegistry>> | undefined;
async function providerRegistry() {
  registryPromise ??= (async () =>
    createProviderRegistry(await loadCustomProviderPorts(new FileCustomProviderStore())))();
  return registryPromise;
}
const modelCatalogs = [
  new CachingModelCatalog(new OpenRouterModelCatalog(), new FileModelCatalogCache()),
  new CachingModelCatalog(new MetaModelCatalog(), new FileModelCatalogCache()),
];

export function providerAccountsHelp(): string {
  return [
    "swisscode accounts --provider <id> <command>",
    "",
    "  add <id> [--label <l>] [--set key=value ...]     Store an account",
    "  update <id> [--label <l>] [--set key=value ...]  Update label/fields (only sent keys change)",
    "  list                                             List accounts (masked)",
    "  show <id>                                     Show account (masked)",
    "  usage [id]                                    Live usage, when the provider exposes it",
  "  models                                        Model list, when the provider publishes one",
  "  model <id>                                  Model detail + serving providers",
  "  test [--set key=value ...]                  Test config without saving it",
    "  remove <id>                                   Delete an account",
    "  current                                       Show the current login (importable providers)",
  ].join("\n");
}

function flag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) out.push(args[i + 1] as string);
  }
  return out;
}

function singleFlag(args: string[], name: string): string | undefined {
  return flag(args, name)[0];
}

async function maskedConfig(account: ProviderAccount): Promise<Record<string, string>> {
  const provider = (await providerRegistry()).get(account.providerId);
  const secretKeys = new Set(
    (provider?.fields ?? []).filter((f) => f.secret).map((f) => f.key),
  );
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(account.config)) {
    out[key] = secretKeys.has(key) || /key|token|secret/i.test(key) ? maskSecret(value) : value;
  }
  return out;
}

export async function cmdProviderAccount(providerId: string, args: string[]): Promise<void> {
  const provider = (await providerRegistry()).get(providerId);
  if (!provider) {
    console.error(`Unknown provider "${providerId}".`);
    process.exitCode = 1;
    return;
  }
  const [sub, ...rest] = args;

  if ((sub === "add" || sub === "update") && rest[0]) {
    const id = rest[0] as string;
    const prev = await store.get(providerId, id);
    if (sub === "add" && prev) {
      console.error(`Account "${id}" already exists for ${providerId}.`);
      process.exitCode = 1;
      return;
    }
    if (sub === "update" && !prev) {
      console.error(`Unknown ${providerId} account "${id}".`);
      process.exitCode = 1;
      return;
    }
    const config: Record<string, string> = { ...(prev?.config ?? {}) };
    for (const pair of flag(rest, "--set")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        console.error(`Bad --set "${pair}". Use --set key=value.`);
        process.exitCode = 1;
        return;
      }
      config[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const missing = provider.fields
      .filter((f) => f.required)
      .map((f) => f.key)
      .filter((k) => !(config[k] ?? "").trim());
    if (missing.length > 0) {
      console.error(`Missing required fields: ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const now = new Date().toISOString();
    await store.save({
      id,
      providerId,
      label: singleFlag(rest, "--label") ?? prev?.label ?? id,
      config,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`${sub === "add" ? "Stored" : "Updated"} ${providerId} account "${id}".`);
    return;
  }

  if (sub === "list") {
    const all = await store.list(providerId);
    if (all.length === 0) {
      console.log(`No ${providerId} accounts stored.`);
      return;
    }
    for (const a of all) console.log(`${a.id}\t${a.label}`);
    return;
  }

  if (sub === "show" && rest[0]) {
    const account = await store.get(providerId, rest[0] as string);
    if (!account) {
      console.error(`Unknown ${providerId} account "${rest[0]}".`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ...account, config: await maskedConfig(account) }, null, 2));
    return;
  }

  if (sub === "usage") {
    const reader = usageReaders.find((r) => r.providerId === providerId);
    if (!reader || !provider.accountCapabilities.usageMetrics) {
      console.log(`${provider.displayName} exposes no usage API.`);
      return;
    }
    const targets = rest[0] ? [rest[0] as string] : (await store.list(providerId)).map((a) => a.id);
    for (const id of targets) {
      const account = await store.get(providerId, id);
      if (!account) {
        console.log(`${id}: unknown account`);
        continue;
      }
      try {
        const snapshot = await reader.readUsage(account);
        console.log(`${id}: ${snapshot.metrics.map((m) => `${m.label}=${m.value}`).join("  ")}`);
      } catch (err) {
        console.log(`${id}: unavailable (${(err as Error).message})`);
      }
    }
    return;
  }

  if (sub === "models") {
    const catalog = modelCatalogs.find((c) => c.providerId === providerId);
    if (!catalog || !provider.accountCapabilities.modelCatalog) {
      console.log(`${provider.displayName} publishes no model list.`);
      return;
    }
    try {
      const snapshot = await catalog.snapshot();
      const cached = snapshot.stale ? `  (stale, as of ${snapshot.fetchedAt})` : "";
      console.log(`${providerId} models (${snapshot.models.length})${cached}:`);
      for (const m of snapshot.models) {
        console.log(`  ${m.id}${m.name ? ` — ${m.name}` : ""}`);
      }
    } catch (err) {
      console.log(`${providerId} models unavailable (${(err as Error).message})`);
    }
    return;
  }

  if (sub === "model" && rest[0]) {
    const modelId = rest[0] as string;
    const catalog = modelCatalogs.find((c) => c.providerId === providerId);
    if (!catalog || !provider.accountCapabilities.modelCatalog) {
      console.log(`${provider.displayName} publishes no model list.`);
      return;
    }
    try {
      const snapshot = await catalog.snapshot();
      const model = snapshot.models.find((m) => m.id === modelId);
      if (!model) {
        console.log(`Unknown model "${modelId}".`);
        return;
      }
      console.log(`${model.name ?? model.id}${snapshot.stale ? `  (stale, as of ${snapshot.fetchedAt})` : ""}`);
      console.log(`  id: ${model.id}`);
      if (model.creator) console.log(`  creator: ${model.creator}`);
      if (model.created) console.log(`  released: ${model.created.slice(0, 10)}`);
      if (model.contextLength !== undefined) console.log(`  context: ${model.contextLength}`);
      if (model.maxCompletionTokens !== undefined) {
        console.log(`  max out: ${model.maxCompletionTokens}`);
      }
      if (model.promptPerMillion !== undefined || model.completionPerMillion !== undefined) {
        console.log(
          `  price: $${model.promptPerMillion?.toFixed(2) ?? "?"} in / $${model.completionPerMillion?.toFixed(2) ?? "?"} out per 1M`,
        );
      }
      if (model.inputModalities) console.log(`  inputs: ${model.inputModalities.join(" + ")}`);
      if (provider.accountCapabilities.modelEndpoints) {
        try {
          const eps = await catalog.endpoints(modelId);
          console.log(`  serving providers (${eps.endpoints.length}):`);
          for (const e of eps.endpoints) {
            const price =
              e.promptPerMillion !== undefined || e.completionPerMillion !== undefined
                ? `  $${e.promptPerMillion?.toFixed(2) ?? "?"} in / $${e.completionPerMillion?.toFixed(2) ?? "?"} out`
                : "";
            const quant = e.quantization ? `  ${e.quantization}` : "";
            console.log(`    ${e.provider}${e.tag ? ` (${e.tag})` : ""}${price}${quant}`);
          }
        } catch (err) {
          console.log(`  serving providers unavailable (${(err as Error).message})`);
        }
      }
    } catch (err) {
      console.log(`${providerId} model unavailable (${(err as Error).message})`);
    }
    return;
  }

  if (sub === "test") {
    const { CustomAccountValidator, FileCustomProviderStore, MetaAccountValidator, OpenRouterAccountValidator } =
      await import("@swisscode/adapters");
    let validator;
    if (providerId === "openrouter") {
      validator = new OpenRouterAccountValidator();
    } else if (providerId === "meta") {
      validator = new MetaAccountValidator();
    } else {
      const def = await new FileCustomProviderStore().get(providerId);
      if (!def?.test) {
        console.log(`${provider.displayName} declares no connection test.`);
        return;
      }
      validator = new CustomAccountValidator(def);
    }
    const config: Record<string, string> = {};
    for (const pair of flag(rest, "--set")) {
      const eq = pair.indexOf("=");
      if (eq > 0) config[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const verdict = await validator.validateAccount(config);
    if (verdict.ok) {
      console.log(`OK${verdict.detail ? ` — ${verdict.detail}` : ""}${verdict.label ? ` (${verdict.label})` : ""}`);
    } else {
      console.error(`FAIL — ${verdict.error ?? "unknown error"}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "remove" && rest[0]) {
    const ok = await store.remove(providerId, rest[0] as string);
    console.log(ok ? `Removed "${rest[0]}".` : `Unknown account "${rest[0]}".`);
    return;
  }

  console.log(providerAccountsHelp());
}
