import React, { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import { filterModels } from '../../core/catalog.ts'
import { formatContext, formatPrice } from '../../core/format.ts'
import type { Tier } from '../../ports/provider.ts'
import type {
  CatalogCapabilities,
  ModelCatalogPort,
  NormalizedModel,
} from '../../ports/catalog.ts'

const ROWS = 12
const LEFT_WIDTH = 40

/**
 * TRI-STATE, and the type is what keeps it that way. `boolean | null` cannot be
 * collapsed to `boolean` without a compile error, so "this catalog does not
 * publish tool support" can never be rendered as a confirmed "no".
 */
function Badge({ state, children }: { state: boolean | null; children: ReactNode }) {
  // Tri-state. "unknown" must not look like "no" and must not look like "yes".
  if (state === null || state === undefined) {
    return <Text dimColor>? {children} </Text>
  }
  return (
    <Text {...(state ? { color: 'green' as const } : {})} dimColor={!state}>
      {state ? '✓' : '·'} {children}{' '}
    </Text>
  )
}

function Score({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null
  // 0-100 scale; 20 cells keeps the bar readable in a narrow pane.
  const filled = Math.max(0, Math.min(20, Math.round((value / 100) * 20)))
  return (
    <Box>
      <Box width={13}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color="cyan">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(20 - filled)}</Text>
      <Text> {value}</Text>
    </Box>
  )
}

/**
 * `value: number`, deliberately NOT `number | null`.
 *
 * This is the render side of the port's `pricing: Pricing | null`. A price row
 * can only be built out of a price that a catalog actually published: reaching
 * for `model.pricing.prompt` without first proving `model.pricing` is non-null
 * does not compile, so the "$0.00 over data we do not have" bug is unreachable
 * rather than merely tested for. formatPrice still accepts null because it is
 * called from places where absence is a real input; here it is not.
 */
function PriceRow({ label, value }: { label: string; value: number }) {
  return (
    <Box>
      <Box width={13}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{formatPrice(value)}</Text>
      <Text dimColor> / M tokens</Text>
    </Box>
  )
}

type DetailsProps = {
  /** null when the active filter matches nothing */
  model: NormalizedModel | null
  capabilities: CatalogCapabilities
}

function Details({ model, capabilities }: DetailsProps) {
  if (!model) {
    return <Text dimColor>No model matches this filter.</Text>
  }
  return (
    <Box flexDirection="column">
      <Text bold color="cyan" wrap="truncate-end">
        {model.name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {model.id}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {/* A catalog that publishes no prices gets a stated absence, never a
            "$0.00" that reads as free. */}
        {capabilities.pricing && model.pricing ? (
          <>
            <PriceRow label="input" value={model.pricing.prompt} />
            <PriceRow label="output" value={model.pricing.completion} />
            {model.pricing.cacheRead != null ? (
              <PriceRow label="cache read" value={model.pricing.cacheRead} />
            ) : null}
          </>
        ) : (
          <Text dimColor>pricing not published by this catalog</Text>
        )}
        {model.context ? (
          <Box>
            <Box width={13}>
              <Text dimColor>context</Text>
            </Box>
            <Text>{formatContext(model.context)}</Text>
            {model.maxOutput ? (
              <Text dimColor>{`  (max out ${formatContext(model.maxOutput)})`}</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Badge state={model.tools}>tools</Badge>
        <Badge state={model.reasoning}>reasoning</Badge>
      </Box>
      {model.tools === false ? (
        <Text color="red">Claude Code needs tool calling — this model will not work.</Text>
      ) : null}
      {model.tools === null ? (
        <Text dimColor>
          tool support is not published here; Claude Code needs it, so try a short
          prompt before relying on this model.
        </Text>
      ) : null}

      {capabilities.benchmarks && model.benchmarks ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>artificial analysis</Text>
          <Score label="intelligence" value={model.benchmarks.intelligence} />
          <Score label="coding" value={model.benchmarks.coding} />
          <Score label="agentic" value={model.benchmarks.agentic} />
        </Box>
      ) : null}

      {model.description ? (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {model.description.slice(0, 260).trim()}
            {model.description.length > 260 ? '…' : ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export type ModelPickerProps = {
  /** which tier is being filled; display only */
  tier: Tier | null
  /** the id already pinned for this tier, if any */
  current: string | undefined
  catalog: ModelCatalogPort
  /**
   * The WHOLE row, not just the id. The catalog's context length is the only
   * measured window this codebase ever sees and it is gone once this component
   * unmounts, so the caller gets the row and decides what to keep.
   */
  onSelect: (model: NormalizedModel) => void
  onCancel: () => void
}

/** What `catalog.list()` reported, plus the in-flight flag. */
type PickerState = {
  models: NormalizedModel[]
  loading: boolean
  error: string | null
  stale: boolean
}

export function ModelPicker({ tier, current, catalog, onSelect, onCancel }: ModelPickerProps) {
  const capabilities = catalog.capabilities
  const [state, setState] = useState<PickerState>({
    models: [],
    loading: true,
    error: null,
    stale: false,
  })
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  // Defaulting the tools filter on against a catalog that publishes no
  // capability data would hide every row.
  const [toolsOnly, setToolsOnly] = useState(capabilities.toolSupportKnown)
  const [freeOnly, setFreeOnly] = useState(false)

  useEffect(() => {
    let alive = true
    catalog.list().then((r) => {
      if (!alive) return
      setState({ models: r.models, loading: false, error: r.error, stale: r.stale })
      // Land on whatever is already configured for this tier.
      const idx = r.models.findIndex((m) => m.id === current)
      if (idx >= 0) setCursor(idx)
    })
    return () => {
      alive = false
    }
  }, [current, catalog])

  const visible = useMemo(
    () => filterModels(state.models, { query, toolsOnly, freeOnly }, capabilities),
    [state.models, query, toolsOnly, freeOnly, capabilities],
  )

  // Any filter change can strand the cursor past the end of the new list.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, visible.length - 1)))
  }, [visible.length])

  const refresh = () => {
    setState((s) => ({ ...s, loading: true }))
    catalog.list({ force: true }).then((r) =>
      setState({ models: r.models, loading: false, error: r.error, stale: r.stale }),
    )
  }

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) {
      const picked = visible[cursor]
      // The whole row, not just the id: the catalog's context_length is the
      // only measured window we will ever have for this model, and it is gone
      // the moment this component unmounts.
      if (picked) onSelect(picked)
      return
    }
    if (key.ctrl) {
      if (input === 't' && capabilities.toolSupportKnown) setToolsOnly((v) => !v)
      else if (input === 'f' && capabilities.pricing) setFreeOnly((v) => !v)
      else if (input === 'r') refresh()
      return
    }
    if (key.upArrow) return setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) return setCursor((c) => Math.min(visible.length - 1, c + 1))
    if (key.pageUp) return setCursor((c) => Math.max(0, c - ROWS))
    if (key.pageDown) return setCursor((c) => Math.min(visible.length - 1, c + ROWS))
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setCursor(0)
      return
    }
    // Printable characters only — control bytes would corrupt the query.
    if (input && !key.meta && input >= ' ') {
      setQuery((q) => q + input)
      setCursor(0)
    }
  })

  if (state.loading) {
    return <Text dimColor>Loading models from {catalog.label}…</Text>
  }

  if (state.models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="red">Could not reach {catalog.label}: {state.error}</Text>
        <Text dimColor>Press esc to go back and type the model id by hand.</Text>
      </Box>
    )
  }

  // Keep the cursor inside a sliding window so long lists stay navigable.
  const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), visible.length - ROWS))
  const window = visible.slice(Math.max(0, start), Math.max(0, start) + ROWS)
  const selected = visible[cursor] ?? null

  const hints = [
    '↑↓ move',
    '⏎ select',
    'type to search',
    capabilities.toolSupportKnown ? '^T tools' : null,
    capabilities.pricing ? '^F free' : null,
    '^R refresh',
    'esc back',
  ].filter(Boolean)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">model for </Text>
        <Text bold>{tier}</Text>
        <Text dimColor>  ·  search: </Text>
        <Text>{query}</Text>
        <Text color="cyan">▌</Text>
      </Box>
      <Box>
        <Text dimColor>
          {visible.length}/{state.models.length} shown
          {toolsOnly && capabilities.toolSupportKnown ? ' · tools only' : ''}
          {freeOnly && capabilities.pricing ? ' · free only' : ''}
          {capabilities.pricing ? '' : ' · no pricing published'}
          {state.stale ? ' · offline, cached' : ''}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Box flexDirection="column" width={LEFT_WIDTH}>
          {window.length === 0 ? (
            <Text dimColor>no matches</Text>
          ) : (
            window.map((m) => {
              const active = visible[cursor]?.id === m.id
              return (
                <Box key={m.id}>
                  <Text
                    {...(active ? { color: 'cyan' as const } : {})}
                    dimColor={!active}
                    wrap="truncate-end"
                  >
                    {active ? '› ' : '  '}
                    {m.id === current ? '● ' : ''}
                    {m.id}
                  </Text>
                </Box>
              )
            })
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
          <Details model={selected} capabilities={capabilities} />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{hints.join(' · ')}</Text>
      </Box>
    </Box>
  )
}
