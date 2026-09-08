import { createServerFn } from "@tanstack/react-start";
import type { Profile } from "@swisscode/core";
import {
  deleteProfile,
  getAgents,
  getProfiles,
  getProviders,
  previewProfile,
  saveProfile,
  storePath,
} from "./store.server";

export const listProfilesFn = createServerFn({ method: "GET" }).handler(async () => ({
  profiles: await getProfiles(),
  storePath: storePath(),
}));

export const catalogFn = createServerFn({ method: "GET" }).handler(async () => ({
  agents: getAgents(),
  providers: getProviders(),
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
