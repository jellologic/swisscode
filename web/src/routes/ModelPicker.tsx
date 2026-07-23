import { useEffect, useMemo, useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type CatalogModel, type CatalogResult } from '../api'
import { Banner, Button, inputStyle } from '../ui'
// The SAME filtering, ranking and formatting the Ink picker uses. These are
// properties of the data, not of the widget, and the browser had drifted:
// its own copy dropped the free-only filter, never sorted at all, and rendered
// a free model as "$0.00/M" — the exact thing this file's header forbids.
import { filterModels, rank } from '../../../src/core/catalog'
import { formatContext, formatPrice } from '../../../src/core/format'

/**
 * The browsable model list, for providers that publish one.
 *
 * Two rules carried over from the Ink picker, because they are properties of the
 * data rather than of the widget:
 *
 *   * `tools` is TRI-STATE. Only a CONFIRMED absence hides a row; UNKNOWN stays
 *     visible. Collapsing them would empty the list for any catalog that does
 *     not publish capability at all.
 *   * Nothing missing is rendered as a number. A catalog with no prices shows
 *     no prices, rather than "$0.00", which would read as free.
 */
/**
 * The per-million price pair, or just "free".
 *
 * `formatPrice` already returns "free" for zero — appending "/M in" to that
 * gives "free/M in", which is not a thing anyone says. The FORMATTING is
 * core's; only this bit of phrasing is the browser's, which is exactly the
 * split that should exist between them.
 */
function priceLabel(pricing: { prompt: number; completion: number }): string {
  const input = formatPrice(pricing.prompt)
  const output = formatPrice(pricing.completion)
  return input === 'free' && output === 'free' ? 'free' : `${input}/M in · ${output}/M out`
}

export function ModelPicker({
  catalogId,
  tier,
  onPick,
  onClose,
}: {
  catalogId: string
  tier: string
  onPick: (model: CatalogModel) => void
  onClose: () => void
}) {
  const [data, setData] = useState<CatalogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [toolsOnly, setToolsOnly] = useState(true)
  const [freeOnly, setFreeOnly] = useState(false)

  useEffect(() => {
    let live = true
    api
      .catalog(catalogId)
      .then((r) => live && setData(r))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [catalogId])

  const rows = useMemo(() => {
    if (!data) return []
    // `rank` before display, exactly as the terminal picker does: models with a
    // published coding benchmark first and best-first, then everything else
    // alphabetically. Registry order is arbitrary — it put the useful models
    // wherever the provider happened to list them.
    return filterModels(data.models, { query, toolsOnly, freeOnly }, data.capabilities).sort(rank)
  }, [data, query, toolsOnly, freeOnly])

  return (
    <div
      className={css({
        position: 'fixed',
        inset: '0',
        bg: 'surface.overlay',
        display: 'grid',
        placeItems: 'center',
        p: '6',
        zIndex: 10,
      })}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={css({
          bg: 'surface.panel',
          border: '[1px solid]',
          borderColor: 'border.strong',
          borderRadius: 'lg',
          w: '[100%]',
          maxW: 'content',
          maxH: '[80vh]',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        <header
          className={css({
            p: '3',
            borderBottom: '[1px solid]',
            borderColor: 'border.subtle',
            display: 'flex',
            gap: '2',
            alignItems: 'center',
          })}
        >
          <input
            autoFocus
            className={inputStyle}
            placeholder={`model for ${tier} — search`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button onClick={onClose}>Close</Button>
        </header>

        <div
          className={css({
            px: '3',
            py: '2',
            borderBottom: '[1px solid]',
            borderColor: 'border.subtle',
            display: 'flex',
            gap: '3',
            alignItems: 'center',
            textStyle: 'meta',
            color: 'content.tertiary',
          })}
        >
          <span>
            {rows.length}
            {data ? `/${data.models.length}` : ''} shown
          </span>
          {data?.capabilities.toolSupportKnown ? (
            <label className={css({ display: 'flex', gap: '1.5', alignItems: 'center', cursor: 'pointer' })}>
              <input type="checkbox" checked={toolsOnly} onChange={(e) => setToolsOnly(e.target.checked)} />
              tools only
            </label>
          ) : null}
          {data?.capabilities.pricing ? (
            <label className={css({ display: 'flex', gap: '1.5', alignItems: 'center', cursor: 'pointer' })}>
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
              free only
            </label>
          ) : null}
          {data?.stale ? <span className={css({ color: 'warn.default' })}>stale cache</span> : null}
          {data?.fromCache && !data.stale ? <span>cached</span> : null}
        </div>

        <div className={css({ overflowY: 'auto', flex: '1' })}>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {data?.error && data.models.length === 0 ? (
            <Banner tone="warn">Could not fetch the catalog: {data.error}</Banner>
          ) : null}
          {!data && !error ? (
            <p className={css({ p: '4', color: 'content.tertiary', textStyle: 'meta' })}>loading catalog…</p>
          ) : null}

          {rows.map((m) => (
            <button
              key={m.id}
              onClick={() => onPick(m)}
              className={css({
                display: 'block',
                width: '[100%]',
                textAlign: 'left',
                font: 'inherit',
                bg: 'transparent',
                border: 'none',
                borderBottom: '[1px solid]',
                borderColor: 'border.subtle',
                px: '3',
                py: '2',
                cursor: 'pointer',
                transitionProperty: 'colors',
                _hover: { bg: 'surface.hover' },
              })}
            >
              <div className={css({ display: 'flex', gap: '2', alignItems: 'baseline' })}>
                <code className={css({ fontFamily: 'mono', textStyle: 'meta', color: 'content.primary' })}>
                  {m.id}
                </code>
                {m.tools === false ? (
                  <span className={css({ textStyle: 'micro', color: 'danger.default' })}>no tools</span>
                ) : null}
                {m.tools === null ? (
                  <span className={css({ textStyle: 'micro', color: 'content.tertiary' })}>tools unknown</span>
                ) : null}
              </div>
              <div className={css({ textStyle: 'meta', color: 'content.tertiary', mt: '0.5' })}>
                {m.name}
                {/* Absent data stays absent. "$0.00" would read as free. */}
                {m.pricing ? ` · ${priceLabel(m.pricing)}` : ''}
                {m.context ? ` · ${formatContext(m.context)} context` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
