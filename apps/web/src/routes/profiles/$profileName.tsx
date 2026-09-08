import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Card, Code, Page, Stack } from "../../design";
import {
  catalogFn,
  listAccountsFn,
  listPresetsFn,
  listProfilesFn,
  listProviderAccountsFn,
} from "../../lib/functions";
import { ProfileForm, profileToForm } from "../../components/ProfileForm";

export const Route = createFileRoute("/profiles/$profileName")({
  loader: async ({ params }) => {
    const stored = await listProfilesFn();
    const profile = stored.profiles.find((p) => p.name === params.profileName);
    if (!profile) throw new Error(`Unknown profile "${params.profileName}".`);
    return {
      profile,
      catalog: await catalogFn(),
      accounts: await listAccountsFn(),
      providerAccounts: await listProviderAccountsFn({ data: {} }),
      presets: await listPresetsFn(),
    };
  },
  component: EditProfilePage,
});

function EditProfilePage() {
  const { profile, catalog, accounts, providerAccounts, presets } = Route.useLoaderData();
  const router = useRouter();
  return (
    <Page
      title={`Edit profile`}
      sub={<>Editing <Code>{profile.name}</Code>. Renames happen by delete + recreate.</>}
    >
      <Stack>
        <Card>
          <h2>Profile</h2>
          <ProfileForm
            agents={catalog.agents}
            providers={catalog.providers}
            subscriptionAccounts={accounts.accounts}
            keyAccounts={providerAccounts.accounts}
            promptPresets={presets.promptPresets}
            initial={profileToForm(profile)}
            nameEditable={false}
            submitLabel="Save changes"
            onSaved={() => void router.navigate({ to: "/profiles" })}
          />
        </Card>
      </Stack>
    </Page>
  );
}
