import { useState } from "react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
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
  Select,
  Stack,
  Table,
} from "../design";
import { notify } from "../design";
import {
  bundleInventoryFn,
  exportBundleFn,
  getGlobalSettingsFn,
  importBundleFn,
  saveGlobalSettingsFn,
} from "../lib/functions";
import { BUNDLE_STORE_KEYS, type GlobalSettings } from "@swisscode/core";

export const Route = createFileRoute("/settings")({
  loader: async () => ({
    inventory: await bundleInventoryFn(),
    rotation: (await getGlobalSettingsFn()).settings,
  }),
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
  const { inventory, rotation } = Route.useLoaderData();
  // Update badge state comes from the root loader — no second fetch.
  const { updateAvailable, latest } = getRouteApi("__root__").useLoaderData();
  const router = useRouter();
  // Opt-in: a backup with live credentials is only produced when this session
  // asks for one, never as the default of a link someone can be sent.
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [overwrite, setOverwrite] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<StoreImportResult[] | null>(null);
  // Rotation toggle + strategy: local edits, saved as one pair on demand.
  const [rotationEnabled, setRotationEnabled] = useState(rotation.rotationEnabled);
  const [rotationStrategy, setRotationStrategy] = useState<GlobalSettings["rotationStrategy"]>(
    rotation.rotationStrategy,
  );
  // Self-update mode: saved together with the rotation pair as one record.
  const [updateMode, setUpdateMode] = useState<GlobalSettings["updateMode"]>(
    rotation.updateMode ?? "auto",
  );

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

  async function onSaveRotation() {
    setError(null);
    try {
      await saveGlobalSettingsFn({ data: { rotationEnabled, rotationStrategy, updateMode } });
      notify.success("Settings saved — the running proxy picks rotation up on its next tick");
      await router.invalidate();
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
          <h2>Proxy rotation</h2>
          <Stack>
            <Check checked={rotationEnabled} onChange={setRotationEnabled}>
              Rotate subscriptions automatically{" "}
              <Muted>(a background check rolls the proxy to the next usable account)</Muted>
            </Check>
            <Field
              label="Strategy"
              hint="Reset-soonest prefers the account whose limit resets first; least-used prefers the coolest account."
            >
              <Select
                value={rotationStrategy}
                onChange={(e) =>
                  setRotationStrategy(e.target.value as GlobalSettings["rotationStrategy"])
                }
              >
                <option value="reset-soonest">reset-soonest</option>
                <option value="least-used">least-used</option>
              </Select>
            </Field>
            <RowActions>
              <Button variant="primary" onClick={() => void onSaveRotation()}>
                Save rotation
              </Button>
            </RowActions>
          </Stack>
        </Card>

        <Card>
          <h2>Updates</h2>
          <Stack>
            {updateAvailable ? (
              <Notice tone="warn">
                swisscode {latest ?? "newer"} is available
                {updateMode === "auto"
                  ? " — background self-update installs it automatically."
                  : " — switch Self-update to auto, or upgrade manually."}
              </Notice>
            ) : null}
            <Field
              label="Self-update"
              hint="Auto installs new releases in the background. Notify-only shows a badge. Off never checks."
            >
              <Select
                value={updateMode}
                onChange={(e) =>
                  setUpdateMode(e.target.value as GlobalSettings["updateMode"])
                }
              >
                <option value="auto">auto</option>
                <option value="notify-only">notify-only</option>
                <option value="off">off</option>
              </Select>
            </Field>
            <RowActions>
              <Button variant="primary" onClick={() => void onSaveRotation()}>
                Save settings
              </Button>
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
