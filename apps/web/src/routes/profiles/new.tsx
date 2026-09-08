import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Card, Page, Stack } from "../../design";
import {
  catalogFn,
  listAccountsFn,
  listProviderAccountsFn,
} from "../../lib/functions";
import { ProfileForm, emptyProfileForm } from "../../components/ProfileForm";

export const Route = createFileRoute("/profiles/new")({
  loader: async () => ({
    catalog: await catalogFn(),
    accounts: await listAccountsFn(),
    providerAccounts: await listProviderAccountsFn({ data: {} }),
  }),
  component: NewProfilePage,
});

function NewProfilePage() {
  const { catalog, accounts, providerAccounts } = Route.useLoaderData();
  const router = useRouter();
  return (
    <Page title="New profile" sub="Pair a coding agent with an AI provider.">
      <Stack>
        <Card>
          <h2>Profile</h2>
          <ProfileForm
            agents={catalog.agents}
            providers={catalog.providers}
            subscriptionAccounts={accounts.accounts}
            keyAccounts={providerAccounts.accounts}
            initial={emptyProfileForm}
            submitLabel="Save profile"
            onSaved={() => void router.navigate({ to: "/profiles" })}
          />
        </Card>
      </Stack>
    </Page>
  );
}
