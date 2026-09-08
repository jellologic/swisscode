// `swisscode init` — scaffold a profile from a named starter preset.
// Non-interactive by design (scripts and SSH): every slot is either flagged
// explicitly or resolved unambiguously from the stores, and the filled profile
// prints before it saves so `--dry-run` previews the same JSON.

import {
  FileAccountRepository,
  FileProfileRepository,
  FileProviderAccountRepository,
  PROFILE_PRESETS,
  defaultProfilesPath,
  defaultSubscriptionsDir,
  fillPresetSlots,
  presetById,
} from "@swisscode/adapters";
import { ProfileError, validateProfile } from "@swisscode/core";

export function initHelp(): string {
  const lines = PROFILE_PRESETS.map((p) => `  ${p.id.padEnd(10)} ${p.title} — ${p.blurb}`);
  return [
    "swisscode init  (scaffold a profile from a starter preset)",
    "",
    "  init                               List starter presets",
    "  init <preset> [--name <name>] [--subscription <id>] [--key <id>] [--dry-run]",
    "",
    ...lines,
    "",
    "Slots fill from your stored accounts. --subscription picks the Claude login,",
    "--key picks the key account (heavy-opus wants an OpenRouter key). When the",
    "choice is unambiguous it is used automatically; otherwise pass the flag.",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function cmdInit(args: string[]): Promise<void> {
  const profiles = new FileProfileRepository(defaultProfilesPath());
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(initHelp());
    return;
  }
  const [presetId, ...rest] = args as [string, ...string[]];
  const preset = presetById(presetId);
  if (!preset) {
    console.error(
      `Unknown preset "${presetId}". Available: ${PROFILE_PRESETS.map((p) => p.id).join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }
  const dryRun = rest.includes("--dry-run");
  const name = flag(rest, "--name") ?? preset.id;

  if (await profiles.get(name)) {
    console.error(`A profile named "${name}" already exists. Pick another with --name <name>.`);
    process.exitCode = 1;
    return;
  }

  // Resolve each slot: explicit flag wins, else the single stored candidate.
  const vault = new FileAccountRepository(defaultSubscriptionsDir());
  const keys = new FileProviderAccountRepository();
  const values: Record<string, string> = {};
  for (const slot of preset.slots) {
    if (slot.kind === "subscription") {
      const explicit = flag(rest, "--subscription");
      if (explicit) {
        if (!(await vault.get(explicit))) {
          console.error(
            `Unknown subscription account "${explicit}". Run \`swisscode accounts list\` to see stored logins.`,
          );
          process.exitCode = 1;
          return;
        }
        values[slot.key] = explicit;
        continue;
      }
      const stored = await vault.list().catch(() => []);
      if (stored.length === 0) {
        console.error(
          `Preset "${preset.id}" needs a Claude login, but the vault is empty. Run \`swisscode accounts import <id>\` first.`,
        );
        process.exitCode = 1;
        return;
      }
      if (stored.length > 1) {
        console.error(
          `Preset "${preset.id}" needs --subscription <id>. Stored logins: ${stored.map((a) => a.id).join(", ")}.`,
        );
        process.exitCode = 1;
        return;
      }
      values[slot.key] = stored[0]!.id;
    } else {
      const explicit = flag(rest, "--key");
      const candidates = (await keys.list().catch(() => [])).filter(
        (a) => a.providerId === slot.providerId,
      );
      if (explicit) {
        if (!candidates.some((a) => a.id === explicit)) {
          console.error(
            `Unknown ${slot.providerId} key account "${explicit}". Run \`swisscode accounts --provider ${slot.providerId} list\` to see stored keys.`,
          );
          process.exitCode = 1;
          return;
        }
        values[slot.key] = explicit;
        continue;
      }
      if (candidates.length === 0) {
        console.error(
          `Preset "${preset.id}" needs an ${slot.providerId} key account, but none is stored. Run \`swisscode accounts --provider ${slot.providerId} add <id> --set apiKey=...\` first.`,
        );
        process.exitCode = 1;
        return;
      }
      if (candidates.length > 1) {
        console.error(
          `Preset "${preset.id}" needs --key <id>. Stored ${slot.providerId} keys: ${candidates.map((a) => a.id).join(", ")}.`,
        );
        process.exitCode = 1;
        return;
      }
      values[slot.key] = candidates[0]!.id;
    }
  }

  let filled;
  try {
    filled = { ...fillPresetSlots(preset, values), name };
    validateProfile(filled);
  } catch (err) {
    console.error(err instanceof ProfileError ? err.message : (err as Error).message);
    process.exitCode = 1;
    return;
  }

  // Print before save: the operator sees exactly what would be stored.
  console.log(JSON.stringify(filled, null, 2));
  if (dryRun) return;
  await profiles.save(filled);
  console.log(`Saved profile "${name}". Launch it with \`swisscode ${name} --dry-run\` first.`);
}
