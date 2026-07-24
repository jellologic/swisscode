import { useEffect, useMemo, useState } from 'react'
import { css, cva, cx } from '../../styled-system/css'
import { ApiError, api, type CatalogModel, type CatalogResult } from '../api'
import { Badge, Banner, Button, Empty, Inline, Modal, SearchInput, Stack, ToggleChip } from '../ui'
// The SAME filtering, ranking and formatting the Ink picker uses. These are
// properties of the data, not of the widget, and the browser had drifted:
// its own copy dropped the free-only filter, never sorted at all, and rendered
// a free model as "$0.00/M" — the exact thing this file's header forbids.
import { filterModels, rank } from '../../../src/core/catalog'
import { formatContext, formatPrice } from '../../../src/core/format'

/**
 * The catalog's tracks, shared by the column header and every row.
 *
 * Scanning three hundred models is a comparison, and a comparison needs edges:
 * the id runs on the flexible track, the numbers sit on fixed ones and are set
 * right-aligned in mono so the digits stack. Prose separated by middots — which
 * is what this list used to be — makes each row a sentence to read instead of a
 * line to compare.
 *
 * A `cva` rather than a template string picked at render time, because Panda is
 * a build-time extractor: a value it can only learn at runtime emits no CSS at
 * all. The price tracks exist only when the catalog publishes prices, since two
 * columns of em dashes on every row is not a fact, it is furniture.
 */
const catalogGrid = cva({
  base: { display: 'grid', alignItems: 'center', gap: '3' },
  variants: {
    pricing: {
      true: { gridTemplateColumns: '[minmax(0, 1fr) 5rem 5rem 4.5rem]' },
      false: { gridTemplateColumns: '[minmax(0, 1fr) 4.5rem]' },
    },
  },
  defaultVariants: { pricing: false },
})

// The `DataRow` gutter and hairline, on a button — the row IS the control here,
// so it cannot be a `DataRow`. Tighter vertically than a `DataRow` on purpose:
// a provider catalog is hundreds of rows long and every extra pixel is a scroll.
const catalogRow = css({
  width: 'full',
  textAlign: 'left',
  font: 'inherit',
  bg: 'transparent',
  // Three sides off, one on — rather than `border: 'none'` followed by a
  // `borderBottom`. `border` is a shorthand that covers the bottom too, so the
  // pair is a race decided by which class Panda emitted last; these three do not
  // overlap, so there is nothing to decide.
  borderTop: 'none',
  borderInline: 'none',
  borderBottom: 'hairline',
  px: '4',
  py: '2',
  cursor: 'pointer',
  transitionProperty: 'colors',
  transitionDuration: 'fast',
  _hover: { bg: 'surface.hover' },
  _last: { borderBottom: 'none' },
})

// Sticky INSIDE the scroller rather than above it: a header in a separate box
// is a scrollbar's width out of alignment with the columns it names, on every
// platform that reserves one.
const columnHeader = css({
  position: 'sticky',
  top: '0',
  zIndex: 'sticky',
  bg: 'surface.panel',
  px: '4',
  py: '1.5',
  borderBottom: 'hairline',
  textStyle: 'micro',
  color: 'content.tertiary',
})

const numericHead = css({ textAlign: 'right' })
const numeric = css({ textStyle: 'code', color: 'content.secondary', textAlign: 'right' })

// A grid item is `min-width: auto` by default, so a 60-character id would push
// straight through the price columns instead of ellipsing inside its own track.
const idCell = css({ minW: '0' })
const idLine = css({ display: 'flex', gap: '2', alignItems: 'baseline', minW: '0' })
const idText = css({
  textStyle: 'code',
  color: 'content.primary',
  minW: '0',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const nameLine = css({
  textStyle: 'meta',
  color: 'content.tertiary',
  mt: '0.5',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
// Banners are bordered boxes, so they need the row's gutter around them rather
// than the full bleed the rows want.
const notice = css({ px: '4', pt: '4' })

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
 *
 * The second rule is also why the unit lives in the column header and not in the
 * cell: `formatPrice` returns "free" for zero, and "free/M in" — which is what
 * appending the unit per row produced — is not a thing anyone says.
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

  // The catalog's own declaration, not an inference from a page of nulls — the
  // same fact the free-only filter branches on, and the SINGLE authority for
  // whether the two price columns exist at all. A catalog that says it does not
  // publish prices shows none, even if some individual model carries one: the
  // columns are grid tracks shared by every row, so "some rows have a price" is
  // not a state this table can be in. Registries that do publish prices declare
  // it, and the alternative — inferring the column from the page you happen to
  // have scrolled to — is how a table's shape starts depending on its filter.
  const pricing = data?.capabilities.pricing ?? false

  return (
    <Modal onClose={onClose} label={`Choose a model for ${tier}`}>
      <header
        className={css({
          px: '4',
          py: '3',
          borderBottom: 'hairline',
          flexShrink: 0,
        })}
      >
        <Stack gap="3">
          <Inline gap="3" justify="between">
            <Inline gap="2" align="baseline" wrap>
              <h2 className={css({ textStyle: 'heading' })}>Model for {tier}</h2>
              <span className={css({ textStyle: 'meta', color: 'content.tertiary' })}>
                {rows.length}
                {data ? `/${data.models.length}` : ''} shown
              </span>
              {data?.stale ? <Badge tone="warn">stale cache</Badge> : null}
              {data?.fromCache && !data.stale ? <Badge>cached</Badge> : null}
            </Inline>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </Inline>

          <Inline gap="2" wrap>
            <SearchInput
              autoFocus
              grow
              value={query}
              onChange={setQuery}
              placeholder="search models"
              label={`Search models for ${tier}`}
            />
            {data?.capabilities.toolSupportKnown ? (
              <ToggleChip pressed={toolsOnly} onClick={() => setToolsOnly(!toolsOnly)}>
                tools only
              </ToggleChip>
            ) : null}
            {data?.capabilities.pricing ? (
              <ToggleChip pressed={freeOnly} onClick={() => setFreeOnly(!freeOnly)}>
                free only
              </ToggleChip>
            ) : null}
          </Inline>
        </Stack>
      </header>

      <div className={css({ overflowY: 'auto', flex: '1' })}>
        {error ? (
          <div className={notice}>
            <Banner tone="danger">{error}</Banner>
          </div>
        ) : null}
        {data?.error && data.models.length === 0 ? (
          <div className={notice}>
            <Banner tone="warn">Could not fetch the catalog: {data.error}</Banner>
          </div>
        ) : null}
        {!data && !error ? <Empty>Loading catalog…</Empty> : null}
        {data && data.models.length > 0 && rows.length === 0 ? (
          <Empty>Nothing matches. Try a different search, or turn off a filter above.</Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className={cx(columnHeader, catalogGrid({ pricing }))}>
            <span>model</span>
            {pricing ? (
              <>
                <span className={numericHead}>in $/M</span>
                <span className={numericHead}>out $/M</span>
              </>
            ) : null}
            <span className={numericHead}>context</span>
          </div>
        ) : null}

        {rows.map((m) => (
          <button
            key={m.id}
            onClick={() => onPick(m)}
            className={cx(catalogRow, catalogGrid({ pricing }))}
          >
            <div className={idCell}>
              <div className={idLine}>
                <span className={idText}>{m.id}</span>
                {/* A confirmed absence breaks agent use, so it gets a status
                    ground; an unknown is the lack of a fact and stays quiet. */}
                {m.tools === false ? <Badge tone="danger">no tools</Badge> : null}
                {m.tools === null ? (
                  <span className={css({ textStyle: 'micro', color: 'content.tertiary' })}>
                    tools unknown
                  </span>
                ) : null}
              </div>
              <div className={nameLine}>{m.name}</div>
            </div>
            {pricing ? (
              <>
                {/* Absent data stays absent: `formatPrice` renders a dash for a
                    missing price, never "$0.00", which would read as free. */}
                <span className={numeric}>{formatPrice(m.pricing?.prompt ?? null)}</span>
                <span className={numeric}>{formatPrice(m.pricing?.completion ?? null)}</span>
              </>
            ) : null}
            <span className={numeric}>{formatContext(m.context)}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
