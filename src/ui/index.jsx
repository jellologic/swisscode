import React, { useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import { saveConfig } from '../config.js'
import { PROVIDERS, byId } from '../providers.js'

const TIERS = [
  { key: 'opus', label: 'opus' },
  { key: 'sonnet', label: 'sonnet' },
  { key: 'haiku', label: 'haiku' },
]

const mask = (s) => (s ? '•'.repeat(Math.min(s.length, 24)) : '')

function Frame({ children }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          cuckoocode
        </Text>
        <Text dimColor>  ·  esc to cancel</Text>
      </Box>
      {children}
    </Box>
  )
}

function Row({ label, value, dim }) {
  return (
    <Box>
      <Box width={12}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text dimColor={dim}>{value}</Text>
    </Box>
  )
}

function Summary({ provider, baseUrl, apiKey, models }) {
  if (!provider) return null
  const url = provider.askBaseUrl ? baseUrl : provider.baseUrl
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Row label="provider" value={provider.label} />
      {url ? <Row label="endpoint" value={url} /> : null}
      {apiKey ? <Row label="key" value={mask(apiKey)} /> : null}
      {models && (models.opus || models.sonnet || models.haiku) ? (
        <Row
          label="models"
          value={TIERS.map((t) => models[t.key] || '—').join('  /  ')}
        />
      ) : null}
    </Box>
  )
}

export function App({ initial, onResult }) {
  const { exit } = useApp()
  const [step, setStep] = useState('provider')
  const [providerId, setProviderId] = useState(initial?.provider ?? null)
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [models, setModels] = useState(
    initial?.models ?? { opus: '', sonnet: '', haiku: '' },
  )
  const [tier, setTier] = useState(0)

  const provider = byId(providerId)

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onResult(null)
      exit()
    }
  })

  const chooseProvider = (id) => {
    setProviderId(id)
    // Keep hand-edited models when re-configuring the same provider; otherwise
    // start from that provider's defaults.
    setModels(
      initial?.provider === id && initial?.models
        ? initial.models
        : { ...byId(id).models },
    )
    if (byId(id).askBaseUrl) setStep('baseUrl')
    else setStep('apiKey')
  }

  const finish = (skipPermissions) => {
    const cfg = {
      provider: providerId,
      ...(provider.askBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
      apiKey: apiKey.trim(),
      models,
      skipPermissions,
    }
    saveConfig(cfg)
    onResult(cfg)
    exit()
  }

  if (step === 'provider') {
    const items = PROVIDERS.map((p) => ({ label: p.label, value: p.id }))
    const index = Math.max(0, PROVIDERS.findIndex((p) => p.id === providerId))
    return (
      <Frame>
        <Text>Which provider should Claude Code talk to?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            initialIndex={index}
            onSelect={(item) => chooseProvider(item.value)}
          />
        </Box>
      </Frame>
    )
  }

  if (step === 'baseUrl') {
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} models={models} />
        <Text>Base URL for the Anthropic-compatible endpoint:</Text>
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://…"
            onSubmit={() => baseUrl.trim() && setStep('apiKey')}
          />
        </Box>
      </Frame>
    )
  }

  if (step === 'apiKey') {
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} models={models} />
        <Text>
          API key <Text dimColor>({provider.keyEnv})</Text>
        </Text>
        {provider.keyHint ? <Text dimColor>{provider.keyHint}</Text> : null}
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            mask="•"
            placeholder={provider.keyOptional ? 'optional' : 'paste key'}
            onSubmit={() => {
              if (apiKey.trim() || provider.keyOptional) setStep('models')
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>stored at ~/.config/cuckoocode/config.json (chmod 600)</Text>
        </Box>
      </Frame>
    )
  }

  if (step === 'models') {
    return (
      <Frame>
        <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} />
        <Text>Model for each tier <Text dimColor>· enter to advance</Text></Text>
        {provider.modelHint ? <Text dimColor>{provider.modelHint}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {TIERS.map((t, i) => (
            <Box key={t.key}>
              <Box width={9}>
                <Text color={i === tier ? 'cyan' : undefined} dimColor={i !== tier}>
                  {i === tier ? '› ' : '  '}
                  {t.label}
                </Text>
              </Box>
              <TextInput
                value={models[t.key]}
                focus={i === tier}
                showCursor={i === tier}
                placeholder="—"
                onChange={(v) => setModels((m) => ({ ...m, [t.key]: v }))}
                onSubmit={() => (i === TIERS.length - 1 ? setStep('perms') : setTier(i + 1))}
              />
            </Box>
          ))}
        </Box>
      </Frame>
    )
  }

  return (
    <Frame>
      <Summary provider={provider} baseUrl={baseUrl} apiKey={apiKey} models={models} />
      <Text>Pass --dangerously-skip-permissions by default?</Text>
      <Text dimColor>override per run with --safe or --yolo</Text>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: 'yes — skip permission prompts', value: true },
            { label: 'no  — prompt as normal', value: false },
          ]}
          initialIndex={initial?.skipPermissions === false ? 1 : 0}
          onSelect={(item) => finish(item.value)}
        />
      </Box>
    </Frame>
  )
}

export async function runUi({ initial = null } = {}) {
  let result = null
  const app = render(<App initial={initial} onResult={(cfg) => { result = cfg }} />, {
    exitOnCtrlC: false,
  })
  // Waiting for a full unmount matters: Ink has to restore the terminal (raw
  // mode, cursor) before we hand the tty over to Claude Code.
  await app.waitUntilExit()
  return result
}
