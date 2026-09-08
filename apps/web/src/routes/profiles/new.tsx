import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Profile } from "@swisscode/core";
import { Card, Field, Muted, Page, Select, Stack } from "../../design";
import {
  catalogFn,
  listAccountsFn,
  listPresetsFn,
  listProviderAccountsFn,
} from "../../lib/functions";
import { ProfileForm, emptyProfileForm, profileToForm } from "../../components/ProfileForm";

export const Route = createFileRoute("/profiles/new")({
  loader: async () => ({
    catalog: await catalogFn(),
    accounts: await listAccountsFn(),
    providerAccounts: await listProviderAccountsFn({ data: {} }),
    presets: await listPresetsFn(),
  }),
  component: NewProfilePage,
});

/**
 * Copy-fill, never linked: picking a preset copies its values into the form
 * (placeholders become blanks for the selects below) and the preset stays
 * behind — later preset edits never surprise this profile. The form holds its
 * own useState from `initial`, so a remount key applies the copy.
 */
function presetToProfile(preset: { profile: Profile }): Profile {
  return JSON.parse(
    JSON.stringify(preset.profile).replace(/\$\{[A-Za-z0-9_]+\}/g, ""),
  ) as Profile;
}

function NewProfilePage() {
  const { catalog, accounts, providerAccounts, presets } = Route.useLoaderData();
  const router = useRouter();
  const [formKey, setFormKey] = useState(0);
  const [initial, setInitial] = useState(emptyProfileForm);
  const [picked, setPicked] = useState("");

  const pick = (id: string) => {
    setPicked(id);
    if (!id) {
      setInitial(emptyProfileForm);
      setFormKey((k) => k + 1);
      return;
    }
    const preset = presets.presets.find((p) => p.id === id);
    if (!preset) return;
    setInitial(profileToForm(presetToProfile(preset)));
    setFormKey((k) => k + 1);
  };

  return (
    <Page title="New profile" sub="Pair a coding agent with an AI provider.">
      <Stack>
        <Card>
          <h2>Start from…</h2>
          <Field label="Starter preset (optional — copies values in, never linked)">
            <Select value={picked} onChange={(e) => pick(e.target.value)}>
              <option value="">Blank profile</option>
              {presets.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} — {p.blurb}
                </option>
              ))}
            </Select>
          </Field>
          {picked && (
            <p>
              <Muted>
                Blank account fields below mean the preset needs a stored account —
                pick one (or import it on /accounts first).
              </Muted>
            </p>
          )}
        </Card>
        <Card>
          <h2>Profile</h2>
          <ProfileForm
            key={formKey}
            agents={catalog.agents}
            providers={catalog.providers}
            subscriptionAccounts={accounts.accounts}
            keyAccounts={providerAccounts.accounts}
            promptPresets={presets.promptPresets}
            initial={initial}
            submitLabel="Save profile"
            onSaved={() => void router.navigate({ to: "/profiles" })}
          />
        </Card>
      </Stack>
    </Page>
  );
}
