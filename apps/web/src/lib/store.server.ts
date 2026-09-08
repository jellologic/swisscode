// Server-only data access. The `.server.` suffix keeps node:fs + API keys
// out of the client bundle. All domain logic goes through @swisscode/core.

import {
  FileProfileRepository,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
} from "@swisscode/adapters";
import { resolveLaunchSpec, validateProfile, type Profile } from "@swisscode/core";

const agents = createAgentRegistry();
const providers = createProviderRegistry();
const profiles = new FileProfileRepository(defaultProfilesPath());

export function getAgents() {
  return agents.list().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    description: a.description,
    command: a.command,
    defaultArgs: a.defaultArgs,
  }));
}

export function getProviders() {
  return providers.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    fields: p.fields,
  }));
}

export async function getProfiles(): Promise<Profile[]> {
  return profiles.list();
}

/** Stored as-is (secrets live in ~/.swisscode, same machine as the CLI). */
export async function saveProfile(profile: Profile): Promise<void> {
  validateProfile(profile);
  await profiles.save(profile);
}

export async function deleteProfile(name: string): Promise<void> {
  await profiles.remove(name);
}

/** Resolve a profile to its launch spec, with secrets redacted. */
export async function previewProfile(name: string) {
  const profile = await profiles.get(name);
  if (!profile) throw new Error(`Unknown profile "${name}"`);
  const spec = resolveLaunchSpec(agents, providers, profile);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) {
    env[k] = /TOKEN|KEY|SECRET/i.test(k) && v ? "***redacted***" : v;
  }
  return { command: spec.command, args: spec.args, env };
}

export function storePath(): string {
  return profiles.path;
}
