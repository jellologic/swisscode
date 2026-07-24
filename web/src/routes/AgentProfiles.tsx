import { Fragment, useState } from 'react'
import { css, cva, cx } from '../../styled-system/css'
import { ApiError, api, type Bootstrap } from '../api'
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Code,
  DataList,
  DataRow,
  Dot,
  Empty,
  Field,
  FormActions,
  Inline,
  KeyValue,
  KeyValueList,
  Mono,
  Note,
  PageHeader,
  Panel,
  SectionLabel,
  Stack,
  inputStyle,
  labelStyle,
  monoInput,
  selectStyle,
} from '../ui'
import { EmptyState } from '../Brand'
import { ModelPicker } from './ModelPicker'

/**
 * The four tiers as ONE grid rather than four independent rows.
 *
 * A `Field` per tier gave every row its own label width and its own input edge,
 * so four controls describing one thing lined up on nothing. Sharing the tracks
 * is what makes a blank tier visible at a glance, and that is the entire point
 * of this panel: Claude Code reads the extended-context marker per variable, so
 * the tier nobody filled in is the one that silently runs narrow.
 *
 * A `cva` rather than a template string chosen at render time, because Panda is
 * a build-time extractor: a value it can only learn at runtime emits no CSS at
 * all. The third track exists only when there is a catalog to browse — with no
 * Browse button the auto-placement would wrap the next tier's label into the
 * empty column and undo the alignment this grid is for.
 */
const modelGrid = cva({
  base: { display: 'grid', alignItems: 'center', columnGap: '3', rowGap: '2' },
  variants: {
    browsable: {
      true: { gridTemplateColumns: '[auto minmax(0, 1fr) auto]' },
      false: { gridTemplateColumns: '[auto minmax(0, 1fr)]' },
    },
  },
  defaultVariants: { browsable: false },
})

// The same type as a `Field` label, because that is what it is — so it names the
// shared class rather than restating it. What differs is that it sits in a
// shared column instead of owning its own row, and that it is clickable.
const tierLabel = cx(labelStyle, css({ cursor: 'pointer' }))

/**
 * Agent profiles — what runs.
 *
 * Holds no credential, which is why this screen has no password field and no
 * redaction to think about. It is also the thing that can be SHARED: one setup
 * ("Claude Code, yolo, glm on every tier") backing several profiles, each
 * pointed at a different account. The listing says when one is shared, because
 * editing a shared setup changes every profile that uses it.
 *
 * The model picker needs a provider to browse, and an agent profile has none —
 * so it borrows one from a profile that uses this setup. When nothing does,
 * there is no catalog to offer and the fields stay plain text, which is the
 * honest answer rather than a picker over a list we cannot obtain.
 */
export function AgentProfiles({ data, reload }: { data: Bootstrap; reload: () => Promise<void> }) {
  const agentProfiles = Object.entries(data.state.agentProfiles ?? {})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [picking, setPicking] = useState<string | null>(null)
  // The provider whose catalog the Browse buttons search. `null` means "derive a
  // sensible default" — see the editor. It is a LENS, never stored: a model id
  // pinned here is a bare, provider-agnostic string, so which catalog you
  // browsed it from is not part of the saved setup.
  const [browseProviderId, setBrowseProviderId] = useState<string | null>(null)

  const open = (name: string | null) => {
    setError(null)
    setWarnings([])
    setEditing(name ?? '')
    // Re-derive the browse default for whichever profile just opened.
    setBrowseProviderId(null)
    setDraft(name ? { ...data.state.agentProfiles[name] } : { models: {}, compat: {} })
  }

  const save = async (name: string) => {
    setError(null)
    try {
      await api.saveAgentProfile(name, draft, data.revision)
      setEditing(null)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const remove = async (name: string) => {
    setError(null)
    try {
      const res = await api.deleteAgentProfile(name, data.revision)
      if (res.affectedProfiles.length > 0) {
        setWarnings([
          `These profiles still reference "${name}" and will not launch until you repoint ` +
            `them: ${res.affectedProfiles.join(', ')}`,
        ])
      }
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const put = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }))
  const models = (draft.models as Record<string, string>) ?? {}
  const compat = (draft.compat as Record<string, boolean>) ?? {}

  /** Which profiles use a given agent profile — the reverse index. */
  const usersOf = (name: string) =>
    Object.entries(data.state.profiles ?? {})
      .filter(([, p]) => p.agentProfile === name)
      .map(([n]) => n)

  if (editing !== null) {
    const isNew = !data.state.agentProfiles?.[editing]
    const users = usersOf(editing)

    // The agent decides how many model slots exist and which behaviour applies —
    // `data.tiers` is Claude Code's four, but Kilo runs one model and OpenCode a
    // primary + a small. Reading capabilities here is what stops the editor
    // offering inputs and flags the selected agent silently ignores.
    const agentId = (draft.agent as string) || 'claude-code'
    const agentInfo = data.agents.find((a) => a.id === agentId)
    const modelShape = agentInfo?.capabilities.models ?? 'tiers'
    const supportsCompat = agentInfo?.capabilities.compatFlags ?? true
    const usesExtendedContext = agentInfo?.capabilities.extendedContextSuffix ?? true
    // The slots to show, mapped onto the tier keys the adapters actually read:
    // Kilo reads `opus`; OpenCode reads `opus` (primary) + `haiku` (small);
    // Claude Code reads all four. Hidden tiers keep their stored value.
    const visibleSlots: { tier: string; label: string }[] =
      modelShape === 'single'
        ? [{ tier: 'opus', label: 'model' }]
        : modelShape === 'primary+small'
          ? [
              { tier: 'opus', label: 'primary' },
              { tier: 'haiku', label: 'small' },
            ]
          : data.tiers.map((t) => ({ tier: t, label: t }))

    // The catalog LENS: browse against a chosen provider rather than an implicit
    // borrow. Default to the provider a downstream profile pairs this setup with,
    // then the default profile's provider, then any browsable one — but let the
    // user change it, and never store the choice.
    const borrowedProviderId = (() => {
      const viaProfile = users.map((n) => data.state.profiles[n]).find(Boolean)
      const acc = viaProfile?.accounts?.[0]
        ? data.state.providerAccounts?.[viaProfile.accounts[0]]
        : undefined
      return acc?.provider
    })()
    const defaultProfileProviderId = (() => {
      const dp = data.state.defaultProfile ? data.state.profiles?.[data.state.defaultProfile] : null
      const acc = dp?.accounts?.[0] ? data.state.providerAccounts?.[dp.accounts[0]] : undefined
      return acc?.provider
    })()
    const firstBrowsableId = data.providers.find((p) => p.catalogId)?.id
    const activeBrowseId =
      browseProviderId ??
      borrowedProviderId ??
      defaultProfileProviderId ??
      firstBrowsableId ??
      data.providers[0]?.id ??
      null
    const provider = data.providers.find((p) => p.id === activeBrowseId) ?? null
    const browsable = Boolean(provider?.catalogId)

    return (
      <>
        <PageHeader
          title={isNew ? 'New agent profile' : `Agent profile · ${editing}`}
          onBack={() => setEditing(null)}
        />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {users.length > 1 ? (
          <Banner tone="warn">
            Shared by {users.length} profiles ({users.join(', ')}). Changes here affect all of them.
          </Banner>
        ) : null}

        <Panel title="Identity">
          {isNew ? (
            <Field label="Name" hint="How profiles refer to this setup.">
              <input
                className={inputStyle}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                placeholder="main"
              />
            </Field>
          ) : null}
          <Field label="Label">
            <input
              className={inputStyle}
              value={(draft.label as string) ?? ''}
              onChange={(e) => put('label', e.target.value)}
            />
          </Field>
          <Field label="Agent" hint="Which coding CLI to launch. Blank uses Claude Code.">
            <select
              className={selectStyle}
              value={String(draft.agent ?? '')}
              onChange={(e) => put('agent', e.target.value)}
            >
              <option value="">Claude Code (default)</option>
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {data.installedAgents?.find((i) => i.id === a.id)?.installed === false
                    ? '  — not installed'
                    : ''}
                </option>
              ))}
            </select>
          </Field>
        </Panel>

        <Panel
          title="Models"
          description={
            (modelShape === 'single'
              ? `${agentInfo?.label ?? 'This agent'} runs a single model. `
              : modelShape === 'primary+small'
                ? `${agentInfo?.label ?? 'This agent'} runs a primary model and a small one for background work. `
                : 'Claude Code runs a model per tier. ') +
            (usesExtendedContext
              ? 'It reads the extended-context marker per variable, so a tier left blank is the bug where the others run wide and it silently does not. '
              : 'Each runs at the endpoint’s own context window. ') +
            'Blank inherits the provider default.'
          }
        >
          <Stack gap="4">
            {/* The catalog lens. Browsing needs a provider and this setup names
                none of its own, so choose which one to browse against — it only
                drives the Browse buttons and the default-model placeholders, and
                is never saved onto the agent profile. */}
            <Field
              label="Browse models against"
              hint="Which provider’s catalog the Browse buttons search. A model id is stored bare, so this choice is not part of the setup."
            >
              <select
                className={selectStyle}
                value={activeBrowseId ?? ''}
                onChange={(e) => setBrowseProviderId(e.target.value)}
              >
                {data.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.catalogId ? '' : '  — no catalog'}
                  </option>
                ))}
              </select>
            </Field>

            {/* The label is not wrapped around its input the way `Field` wraps
                one, because the two live in different grid columns — hence the
                explicit htmlFor, which buys back the click target. */}
            <div className={modelGrid({ browsable })}>
              {visibleSlots.map(({ tier, label }) => (
                <Fragment key={tier}>
                  <label className={tierLabel} htmlFor={`model-${tier}`}>
                    {label}
                  </label>
                  <input
                    id={`model-${tier}`}
                    className={monoInput}
                    value={models[tier] ?? ''}
                    onChange={(e) => put('models', { ...models, [tier]: e.target.value })}
                    placeholder={provider?.defaultModels?.[tier] ?? '—'}
                  />
                  {browsable ? <Button onClick={() => setPicking(tier)}>Browse</Button> : null}
                </Fragment>
              ))}
            </div>
            {provider && !browsable ? (
              <Note>{provider.label} publishes no browsable catalog — type ids by hand.</Note>
            ) : null}
          </Stack>
        </Panel>

        {picking && provider?.catalogId ? (
          <ModelPicker
            catalogId={provider.catalogId}
            tier={picking}
            onClose={() => setPicking(null)}
            onPick={(model) => {
              setDraft((d) => ({
                ...d,
                models: { ...((d.models as Record<string, string>) ?? {}), [picking]: model.id },
                // Capture the MEASURED window alongside the id — the only
                // moment it is known, and what later lets swisscode set an
                // auto-compact window without ever guessing one.
                ...(model.context
                  ? {
                      contextWindows: {
                        ...((d.contextWindows as Record<string, number>) ?? {}),
                        [model.id]: model.context,
                      },
                    }
                  : {}),
              }))
              setPicking(null)
            }}
          />
        ) : null}

        <Panel title="Behaviour">
          <Stack gap="5">
            <Checkbox
              checked={Boolean(draft.skipPermissions)}
              onChange={(v) => put('skipPermissions', v)}
              // Neutral wording: every agent supports skipping prompts, but each
              // lowers it differently (Claude Code's --dangerously-skip-permissions,
              // OpenCode's --auto, Kilo's config permission block), so the concrete
              // flag is shown only for the agent that actually receives it.
              label={
                agentId === 'claude-code' ? (
                  <>
                    Skip permission prompts <Code>--dangerously-skip-permissions</Code>
                  </>
                ) : (
                  <>Skip permission prompts</>
                )
              }
            />

            {/* Gateway compat is a Claude-Code-only mechanism (capabilities.compatFlags).
                For an agent that does not consume it, a checked box would be a
                pure silent no-op — nothing catches it at launch or in the doctor —
                so the section is hidden, and a note explains any flags a previous
                Claude Code setup left behind rather than dropping them. */}
            {supportsCompat ? (
              <Stack gap="2">
                <SectionLabel>Gateway compatibility</SectionLabel>
                {/* A flag that trades something away says what it costs, here as
                    well as on stderr — as the checkbox's note, so the price reads
                    as belonging to that flag rather than competing with its name. */}
                {data.compatFlags.map((flag) => (
                  <Checkbox
                    key={flag.id}
                    checked={Boolean(compat[flag.id])}
                    onChange={(v) => put('compat', { ...compat, [flag.id]: v })}
                    label={<Mono>{flag.id}</Mono>}
                    note={flag.consequence ? `costs: ${flag.consequence}` : undefined}
                    noteTone="warn"
                  />
                ))}
              </Stack>
            ) : Object.values(compat).some(Boolean) ? (
              <Note tone="warn">
                {agentInfo?.label ?? 'This agent'} does not use gateway compatibility flags; the ones
                set here are kept but ignored until this setup runs Claude Code again.
              </Note>
            ) : null}
          </Stack>
        </Panel>

        <FormActions>
          <Button variant="primary" onClick={() => void save(editing)} disabled={!editing.trim()}>
            {isNew ? 'Create agent profile' : 'Save changes'}
          </Button>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
        </FormActions>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Agent profiles"
        meta={`${agentProfiles.length} setup${agentProfiles.length === 1 ? '' : 's'}`}
        description="What runs, with no credential attached — a coding CLI, the model for each tier, and how it should behave. One setup can back several profiles, which is why the list marks the shared ones: editing one changes every profile that uses it."
        actions={
          <Button variant="primary" onClick={() => open(null)}>
            New agent profile
          </Button>
        }
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}

      <Panel flush>
        {agentProfiles.length === 0 ? (
          <EmptyState>No agent profiles yet. An agent profile is a coding CLI plus how it should behave.</EmptyState>
        ) : (
          <DataList>
            {agentProfiles.map(([name, ap]) => {
              const users = usersOf(name)
              // Count only the slots this agent actually reads — a Kilo setup
              // with an opus id is "1 model", not "1 of 4 tiers".
              const shape = data.agents.find((a) => a.id === (ap.agent ?? 'claude-code'))?.capabilities
                .models
              const slots =
                shape === 'single' ? ['opus'] : shape === 'primary+small' ? ['opus', 'haiku'] : data.tiers
              const pinned = slots.filter((t) => ap.models?.[t]).length
              const modelsLabel =
                shape === 'single'
                  ? pinned > 0
                    ? '1 model'
                    : 'provider default'
                  : pinned > 0
                    ? `${pinned} of ${slots.length} ${shape === 'primary+small' ? 'models' : 'tiers'} pinned`
                    : 'provider defaults'
              return (
                <DataRow
                  key={name}
                  align="start"
                  leading={<Dot tone={users.length > 0 ? 'ok' : 'neutral'} />}
                  title={
                    <Inline gap="2" align="baseline" wrap>
                      <span>{name}</span>
                      {users.length > 1 ? <Badge tone="warn">shared</Badge> : null}
                    </Inline>
                  }
                  /*
                    A `KeyValueList`, the same as Profiles, because this row is
                    the same shape: several facts about one entity that do not
                    say what they are on their own. "2/4 tiers pinned" was prose
                    doing a label's job, and a middot run made the reader parse
                    where each fact started. Labelled, they share one column down
                    the list and the eye finds the same fact on every row.
                  */
                  meta={
                    <KeyValueList>
                      <KeyValue label="Agent" mono>
                        {ap.agent ?? 'claude-code'}
                      </KeyValue>
                      <KeyValue label="Models">{modelsLabel}</KeyValue>
                      <KeyValue label="Used by" tone={users.length > 0 ? 'default' : 'neutral'}>
                        {users.length > 0 ? users.join(', ') : 'nothing yet'}
                      </KeyValue>
                    </KeyValueList>
                  }
                  actions={
                    <>
                      <Button onClick={() => open(name)}>Edit</Button>
                      <Button variant="danger" onClick={() => void remove(name)}>
                        Delete
                      </Button>
                    </>
                  }
                />
              )
            })}
          </DataList>
        )}
      </Panel>
    </>
  )
}
