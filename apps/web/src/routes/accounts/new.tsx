import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { AccountValidation } from "@swisscode/core";
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
  Select,
  Stack,
  notify,
} from "../../design";
import {
  catalogFn,
  currentLoginFn,
  importAccountFn,
  saveProviderAccountFn,
  validateProviderAccountFn,
} from "../../lib/functions";
import { AccountFields } from "../../components/AccountFields";

export const Route = createFileRoute("/accounts/new")({
  loader: async () => ({
    catalog: await catalogFn(),
    login: await currentLoginFn(),
  }),
  component: NewAccountPage,
});

function NewAccountPage() {
  const { catalog, login } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [addProvider, setAddProvider] = useState(catalog.providers[0]?.id ?? "");
  const [addId, setAddId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addValues, setAddValues] = useState<Record<string, string>>({});
  const [testVerdict, setTestVerdict] = useState<AccountValidation | null>(null);
  const [testing, setTesting] = useState(false);

  // A verdict belongs to the exact values tested — clear it on any edit.
  useEffect(() => {
    setTestVerdict(null);
  }, [addProvider, addValues]);

  const providerById = new Map(catalog.providers.map((p) => [p.id, p]));
  const addSpec = providerById.get(addProvider);
  /** Email-slug suggestion, e.g. "ada-lovelace" — blank id defaults to this. */
  const suggestedId = (login.login?.email?.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const duplicateId =
    addSpec?.accountCapabilities.importActive ? login.login?.matchedAccountId : undefined;

  async function testConnection() {
    if (!addSpec) return;
    setTesting(true);
    setTestVerdict(null);
    try {
      const verdict = await validateProviderAccountFn({
        data: { providerId: addSpec.id, config: addValues },
      });
      setTestVerdict(verdict);
      if (verdict.ok) {
        if (verdict.label && !addLabel.trim()) setAddLabel(verdict.label);
        notify.success("Connection works");
      }
    } catch (err) {
      setTestVerdict({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!addSpec) return;
    setError(null);
    try {
      if (addSpec.accountCapabilities.importActive) {
        await importAccountFn({ data: { id: addId.trim(), label: addLabel.trim() || undefined } });
        notify.success("Login imported");
      } else {
        await saveProviderAccountFn({
          data: { providerId: addSpec.id, id: addId.trim(), label: addLabel.trim(), config: addValues },
        });
        notify.success("Account saved");
      }
      await router.navigate({ to: "/accounts" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Page title="Add account" sub="Import a Claude login or store a provider key. Test first, save second.">
      <Stack>
        <Card>
          <h2>Account</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <Form onSubmit={onSubmit}>
            <Field label="Provider">
              <Select
                value={addProvider}
                onChange={(e) => { setAddProvider(e.target.value); setAddValues({}); }}
              >
                {catalog.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </Select>
            </Field>
            {addSpec?.accountCapabilities.hint && <p><Muted>{addSpec.accountCapabilities.hint}</Muted></p>}
            <Field
              label={addSpec?.accountCapabilities.importActive ? "Account id (optional)" : "Account id"}
              hint={addSpec?.accountCapabilities.importActive ? `Blank defaults to ${suggestedId || "your login email"}.` : undefined}
            >
              <Input
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
                placeholder={suggestedId || "personal"}
                required={!addSpec?.accountCapabilities.importActive}
              />
            </Field>
            <Field label="Label" hint="Free text. Defaults to email / id.">
              <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} />
            </Field>
            {addSpec && !addSpec.accountCapabilities.importActive && (
              <AccountFields
                providerId={addSpec.id}
                fields={addSpec.fields}
                values={addValues}
                onChange={setAddValues}
                modelCatalog={addSpec.accountCapabilities.modelCatalog}
                modelEndpoints={addSpec.accountCapabilities.modelEndpoints}
              />
            )}
            {duplicateId && (
              <Notice tone="warn">
                Current login is already imported as <Code>{duplicateId}</Code>.
                Use Re-import on that account to refresh its credentials.
              </Notice>
            )}
            {testVerdict &&
              (testVerdict.ok ? (
                <Notice tone="success">
                  Connection works
                  {testVerdict.detail ? ` — ${testVerdict.detail}` : ""}
                  {testVerdict.label ? ` (${testVerdict.label})` : ""}
                </Notice>
              ) : (
                <Notice tone="danger">{testVerdict.error ?? "Connection test failed."}</Notice>
              ))}
            <RowActions>
              {addSpec && !addSpec.accountCapabilities.importActive && addSpec.hasValidator && (
                <Button type="button" onClick={() => void testConnection()} disabled={testing}>
                  {testing ? "Testing…" : "Test connection"}
                </Button>
              )}
              <Button variant="primary" type="submit" disabled={Boolean(duplicateId)}>
                {addSpec?.accountCapabilities.importActive ? "Import current login" : "Save account"}
              </Button>
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
