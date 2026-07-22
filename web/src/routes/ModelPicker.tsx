import { useEffect, useMemo, useState } from 'react'
import { css } from '../../styled-system/css'
import { ApiError, api, type CatalogModel, type CatalogResult } from '../api'
import { Banner, Button, inputStyle } from '../ui'

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
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    // The filter is inert when the catalog cannot speak to tool support, which
    // is what stops it hiding everything.
    const filterActive = toolsOnly && data.capabilities.toolSupportKnown
    return data.models.filter((m) => {
      if (filterActive && m.tools === false) return false
      if (terms.length === 0) return true
      const hay = `${m.id} ${m.name}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [data, query, toolsOnly])

  return (
    <div
      className={css({
        position: 'fixed',
        inset: 0,
        bg: 'rgba(0,0,0,0.55)',
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
          bg: 'panel',
          border: '1px solid',
          borderColor: 'lineStrong',
          borderRadius: 'lg',
          w: '100%',
          maxW: '44rem',
          maxH: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        <header
          className={css({
            p: '3',
            borderBottom: '1px solid',
            borderColor: 'line',
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
            borderBottom: '1px solid',
            borderColor: 'line',
            display: 'flex',
            gap: '3',
            alignItems: 'center',
            fontSize: '11.5px',
            color: 'faint',
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
          {data?.stale ? <span className={css({ color: 'warn' })}>stale cache</span> : null}
          {data?.fromCache && !data.stale ? <span>cached</span> : null}
        </div>

        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {data?.error && data.models.length === 0 ? (
            <Banner tone="warn">Could not fetch the catalog: {data.error}</Banner>
          ) : null}
          {!data && !error ? (
            <p className={css({ p: '4', color: 'faint', fontSize: '12.5px' })}>loading catalog…</p>
          ) : null}

          {rows.map((m) => (
            <button
              key={m.id}
              onClick={() => onPick(m)}
              className={css({
                display: 'block',
                width: '100%',
                textAlign: 'left',
                font: 'inherit',
                bg: 'transparent',
                border: 'none',
                borderBottom: '1px solid',
                borderColor: 'line',
                px: '3',
                py: '2',
                cursor: 'pointer',
                transition: 'background 120ms ease',
                _hover: { bg: 'hover' },
              })}
            >
              <div className={css({ display: 'flex', gap: '2', alignItems: 'baseline' })}>
                <code className={css({ fontFamily: 'mono', fontSize: '12px', color: 'text' })}>
                  {m.id}
                </code>
                {m.tools === false ? (
                  <span className={css({ fontSize: '10.5px', color: 'danger' })}>no tools</span>
                ) : null}
                {m.tools === null ? (
                  <span className={css({ fontSize: '10.5px', color: 'faint' })}>tools unknown</span>
                ) : null}
              </div>
              <div className={css({ fontSize: '11.5px', color: 'faint', mt: '0.5' })}>
                {m.name}
                {/* Absent data stays absent. "$0.00" would read as free. */}
                {m.pricing
                  ? ` · $${(m.pricing.prompt * 1_000_000).toFixed(2)}/M in · $${(
                      m.pricing.completion * 1_000_000
                    ).toFixed(2)}/M out`
                  : ''}
                {m.context ? ` · ${Math.round(m.context / 1000)}K context` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
