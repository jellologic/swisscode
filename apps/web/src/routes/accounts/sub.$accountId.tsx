import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Button,
  Card,
  Code,
  Field,
  Form,
  Input,
  Muted,
  Notice,
  Page,
  RowActions,
  Stack,
  notify,
} from "../../design";
import { listAccountsFn, renameSubscriptionAccountFn } from "../../lib/functions";

export const Route = createFileRoute("/accounts/sub/$accountId")({
  loader: async ({ params }) => {
    const subs = await listAccountsFn();
    const account = subs.accounts.find((a) => a.id === params.accountId);
    if (!account) throw new Error(`Unknown subscription account "${params.accountId}".`);
    return { account };
  },
  component: EditSubscriptionPage,
});

function EditSubscriptionPage() {
  const { account } = Route.useLoaderData();
  const router = useRouter();
  const [label, setLabel] = useState(account.label);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await renameSubscriptionAccountFn({ data: { id: account.id, label } });
      notify.success("Label saved");
      await router.navigate({ to: "/accounts" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Page
      title="Edit account"
      sub={<>Subscription <Code>{account.id}</Code>{account.email ? <> · {account.email}</> : null}.</>}
    >
      <Stack>
        <Card>
          <h2>Label</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <Form onSubmit={onSubmit}>
            <Field label="Label">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <p><Muted>Credentials update via Re-import; only the label is editable here.</Muted></p>
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
