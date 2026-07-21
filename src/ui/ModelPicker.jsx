import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import {
  filterModels,
  formatContext,
  formatPrice,
  loadModels,
} from '../models.js'

const ROWS = 12
const LEFT_WIDTH = 40

function Badge({ on, children }) {
  return (
    <Text color={on ? 'green' : undefined} dimColor={!on}>
      {on ? '✓' : '·'} {children}{' '}
    </Text>
  )
}

function Score({ label, value }) {
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

function Details({ model }) {
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
        <Box>
          <Box width={13}>
            <Text dimColor>input</Text>
          </Box>
          <Text>{formatPrice(model.prompt)}</Text>
          <Text dimColor> / M tokens</Text>
        </Box>
        <Box>
          <Box width={13}>
            <Text dimColor>output</Text>
          </Box>
          <Text>{formatPrice(model.completion)}</Text>
          <Text dimColor> / M tokens</Text>
        </Box>
        {model.cacheRead != null ? (
          <Box>
            <Box width={13}>
              <Text dimColor>cache read</Text>
            </Box>
            <Text>{formatPrice(model.cacheRead)}</Text>
            <Text dimColor> / M tokens</Text>
          </Box>
        ) : null}
        <Box>
          <Box width={13}>
            <Text dimColor>context</Text>
          </Box>
          <Text>{formatContext(model.context)}</Text>
          {model.maxOutput ? (
            <Text dimColor>{`  (max out ${formatContext(model.maxOutput)})`}</Text>
          ) : null}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Badge on={model.tools}>tools</Badge>
        <Badge on={model.reasoning}>reasoning</Badge>
      </Box>
      {!model.tools ? (
        <Text color="red">Claude Code needs tool calling — this model will not work.</Text>
      ) : null}

      {model.aa ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>artificial analysis</Text>
          <Score label="intelligence" value={model.aa.intelligence} />
          <Score label="coding" value={model.aa.coding} />
          <Score label="agentic" value={model.aa.agentic} />
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

export function ModelPicker({ tier, current, onSelect, onCancel }) {
  const [state, setState] = useState({ models: [], loading: true, error: null, stale: false })
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [toolsOnly, setToolsOnly] = useState(true)
  const [freeOnly, setFreeOnly] = useState(false)

  useEffect(() => {
    let alive = true
    loadModels().then((r) => {
      if (!alive) return
      setState({ models: r.models, loading: false, error: r.error, stale: r.stale })
      // Land on whatever is already configured for this tier.
      const idx = r.models.findIndex((m) => m.id === current)
      if (idx >= 0) setQuery('')
    })
    return () => {
      alive = false
    }
  }, [current])

  const visible = useMemo(
    () => filterModels(state.models, { query, toolsOnly, freeOnly }),
    [state.models, query, toolsOnly, freeOnly],
  )

  // Any filter change can strand the cursor past the end of the new list.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, visible.length - 1)))
  }, [visible.length])

  const refresh = () => {
    setState((s) => ({ ...s, loading: true }))
    loadModels({ force: true }).then((r) =>
      setState({ models: r.models, loading: false, error: r.error, stale: r.stale }),
    )
  }

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) {
      const picked = visible[cursor]
      if (picked) onSelect(picked.id)
      return
    }
    if (key.ctrl) {
      if (input === 't') setToolsOnly((v) => !v)
      else if (input === 'f') setFreeOnly((v) => !v)
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
    return <Text dimColor>Loading models from OpenRouter…</Text>
  }

  if (state.models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="red">Could not reach OpenRouter: {state.error}</Text>
        <Text dimColor>Press esc to go back and type the model id by hand.</Text>
      </Box>
    )
  }

  // Keep the cursor inside a sliding window so long lists stay navigable.
  const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), visible.length - ROWS))
  const window = visible.slice(Math.max(0, start), Math.max(0, start) + ROWS)
  const selected = visible[cursor] ?? null

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
          {toolsOnly ? ' · tools only' : ''}
          {freeOnly ? ' · free only' : ''}
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
                  <Text color={active ? 'cyan' : undefined} dimColor={!active} wrap="truncate-end">
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
          <Details model={selected} />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ move · ⏎ select · type to search · ^T tools · ^F free · ^R refresh · esc back
        </Text>
      </Box>
    </Box>
  )
}
