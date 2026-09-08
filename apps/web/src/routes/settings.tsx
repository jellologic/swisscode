import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { StoreImportResult } from "@swisscode/core";
import {
  Button,
  Card,
  Check,
  Code,
  Column,
  Field,
  Input,
  Muted,
  Notice,
  Page,
  RowActions,
  Stack,
  Table,
} from "../design";
import { notify } from "../design";
import {
  bundleInventoryFn,
  exportBundleFn,
  importBundleFn,
} from "../lib/functions";
import { BUNDLE_STORE_KEYS } from "@swisscode/core";

export const Route = createFileRoute("/settings")({
  loader: async () => ({ inventory: await bundleInventoryFn() }),
  component: SettingsPage,
});

const inventoryColumns: Column<{ store: string; records: number }>[] = [
  { header: "Store", render: (r) => <Code>{r.store}</Code> },
  { header: "Records", render: (r) => <Muted>{r.records}</Muted> },
];

const resultColumns: Column<StoreImportResult>[] = [
  { header: "Store", render: (r) => <Code>{r.store}</Code> },
  { header: "Imported", render: (r) => <Muted>{r.imported}</Muted> },
  { header: "Skipped", render: (r) => <Muted>{r.skipped}</Muted> },
  {
    header: "Issues",
    render: (r) =>
      r.errors.length > 0 ? (
        <Muted>{r.errors.join(" · ")}</Muted>
      ) : (
        <Muted>—</Muted>
      ),
  },
];

function SettingsPage() {
  const { inventory } = Route.useLoaderData();
  const router = useRouter();
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [overwrite, setOverwrite] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<StoreImportResult[] | null>(null);

  async function onExport() {
    setError(null);
    try {
      const bundle = await exportBundleFn({ data: { includeSecrets } });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `swisscode-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify.success(`Backup downloaded${includeSecrets ? "" : " (secrets excluded)"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImportFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setResults(null);
    try {
      const raw: unknown = JSON.parse(await file.text());
      const { results: imported } = await importBundleFn({ data: { bundle: raw, overwrite } });
      setResults(imported);
      const total = imported.reduce((n, r) => n + r.imported, 0);
      const problems = imported.reduce((n, r) => n + r.errors.length, 0);
      if (problems > 0) {
        notify.error(`Imported ${total} with ${problems} issue(s) — see table`);
      } else {
        notify.success(`Imported ${total} record(s)`);
      }
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Page
      title="Settings"
      sub="Back up and restore the whole swisscode config. Every store is covered — profiles, subscription logins, key accounts, custom providers."
    >
      <Stack>
        <Card>
          <h2>What&apos;s stored</h2>
          <Table
            columns={inventoryColumns}
            rows={BUNDLE_STORE_KEYS.map((store) => ({ store, records: inventory[store] ?? 0 }))}
            getKey={(r) => r.store}
            empty={<Muted>Nothing stored yet.</Muted>}
          />
          <p>
            <Muted>
              Usage and model-catalog caches are excluded on purpose — they reseed
              themselves from the network.
            </Muted>
          </p>
        </Card>

        <Card>
          <h2>Export</h2>
          <Stack>
            <Check checked={includeSecrets} onChange={setIncludeSecrets}>
              Include secrets <Muted>(OAuth tokens, API keys)</Muted>
            </Check>
            {!includeSecrets && (
              <Notice tone="warn">
                Secrets are stripped: subscription logins will need re-import and key
                accounts will need their keys re-entered after restore.
              </Notice>
            )}
            {includeSecrets && (
              <p>
                <Muted>
                  The file contains live credentials. Store it like a password vault.
                </Muted>
              </p>
            )}
            <RowActions>
              <Button variant="primary" onClick={onExport}>Download backup</Button>
            </RowActions>
          </Stack>
        </Card>

        <Card>
          <h2>Import</h2>
          <Stack>
            <Check checked={overwrite} onChange={setOverwrite}>
              Overwrite existing records <Muted>(off = keep locals, skip bundled dupes)</Muted>
            </Check>
            <Field label="Backup file" hint="Version-checked: newer bundles than this swisscode are refused.">
              <Input
                type="file"
                accept="application/json"
                onChange={(e) => void onImportFile(e.target.files?.[0])}
              />
            </Field>
            {results && (
              <Table
                columns={resultColumns}
                rows={results}
                getKey={(r) => r.store}
                empty={<Muted>No results.</Muted>}
              />
            )}
          </Stack>
        </Card>
        {error && <Notice tone="danger">{error}</Notice>}
      </Stack>
    </Page>
  );
}
