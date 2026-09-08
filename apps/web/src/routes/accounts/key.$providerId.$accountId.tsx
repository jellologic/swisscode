import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Button,
  Card,
  Code,
  Field,
  Form,
  Input,
  Notice,
  Page,
  RowActions,
  Stack,
  notify,
} from "../../design";
import { catalogFn, listProviderAccountsFn, updateProviderAccountFn } from "../../lib/functions";
import { AccountFields } from "../../components/AccountFields";

export const Route = createFileRoute("/accounts/key/$providerId/$accountId")({
  loader: async ({ params }) => {
    const catalog = await catalogFn();
    const provider = catalog.providers.find((p) => p.id === params.providerId);
    if (!provider) throw new Error(`Unknown provider "${params.providerId}".`);
    const listed = await listProviderAccountsFn({ data: { providerId: params.providerId } });
    const account = listed.accounts.find((a) => a.id === params.accountId);
    if (!account) throw new Error(`Unknown ${params.providerId} account "${params.accountId}".`);
    return { provider, account };
  },
  component: EditKeyAccountPage,
});

function EditKeyAccountPage() {
  const { provider, account } = Route.useLoaderData();
  const router = useRouter();
  const [label, setLabel] = useState(account.label);
  const [values, setValues] = useState<Record<string, string>>(account.config);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await updateProviderAccountFn({
        data: { providerId: provider.id, id: account.id, label, config: values },
      });
      notify.success("Account updated");
      await router.navigate({ to: "/accounts" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Page
      title="Edit account"
      sub={<>{provider.displayName} · <Code>{account.id}</Code>.</>}
    >
      <Stack>
        <Card>
          <h2>Account</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <Form onSubmit={onSubmit}>
            <Field label="Label">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <AccountFields
              providerId={provider.id}
              fields={provider.fields}
              values={values}
              onChange={setValues}
              modelCatalog={provider.accountCapabilities.modelCatalog}
              modelEndpoints={provider.accountCapabilities.modelEndpoints}
              secretNote="blank keeps stored"
            />
            <RowActions>
              <Button variant="primary" type="submit">Save</Button>
              <Button variant="ghost" type="button" onClick={() => void router.navigate({ to: "/accounts" })}>
                Cancel
              </Button>
            </RowActions>
          </Form>
        </Card>
      </Stack>
    </Page>
  );
}
