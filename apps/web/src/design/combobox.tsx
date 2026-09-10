import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** One table column in the combobox dropdown. */
export interface ComboColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (item: T) => ReactNode;
  /**
   * Comparable value for sorting. Absent = column not sortable (no
   * affordance shown). `undefined` (missing data) always sorts last.
   */
  sortValue?: (item: T) => string | number | undefined;
}

interface ComboboxProps<T> {
  /** The committed value (item key). Shown in the input when closed. */
  value: string;
  onChange: (value: string) => void;
  items: T[];
  getKey: (item: T) => string;
  /** Searchable text per item (id + name + creator …). */
  searchText: (item: T) => string;
  columns: ComboColumn<T>[];
  placeholder?: string;
  /** Suffix in the dropdown footer, e.g. "428 models". */
  statusText?: string;
  emptyText?: string;
  /** Rows rendered before truncating (default 100). */
  maxRows?: number;
  /**
   * Friendly text for a committed value, shown while closed (e.g. a backend
   * label for an encoded destination). The committed key is untouched — this
   * only changes what the closed input reads. Omit when keys already read
   * well (model ids). While open the input clears so typing filters the full
   * list; blurring without edits reverts, never commits "".
   */
  displayValue?: (value: string, items: T[]) => string | undefined;
}

type SortState = { key: string; dir: 1 | -1 } | null;

function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Search input + sortable table dropdown. Type to filter, click a header to
 * sort, arrows + Enter to pick, Escape to revert. Free-text values are kept
 * (nothing forced). The dropdown portals to the body so card overflow never
 * clips it.
 */
export function Combobox<T>(props: ComboboxProps<T>) {
  const { value, onChange, columns } = props;
  const maxRows = props.maxRows ?? 100;
  // Closed text resolves on first render too, so SSR/hydration agree.
  const display = props.displayValue?.(value, props.items) ?? value;
  const [query, setQuery] = useState(display);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [sort, setSort] = useState<SortState>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set when commit() triggered the blur itself — onBlur must not recommit. */
  const skipBlur = useRef(false);

  /** Set on real keystrokes — separates typed text from a focus-clear. */
  const edited = useRef(false);

  // Mirror external value changes while closed (e.g. form reset).
  useEffect(() => {
    if (!open) {
      setQuery(display);
      edited.current = false;
    }
  }, [display, open]);

  // Anchor the portaled dropdown to the input; flip upward when crowded.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const fitsBelow = below >= 240 || below >= r.top;
      const width = Math.min(Math.max(r.width, 480), window.innerWidth - 16);
      setAnchor({
        top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - 324),
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open ]);

  const { rows, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? props.items.filter((item) => props.searchText(item).toLowerCase().includes(q))
      : [...props.items];
    const spec = sort
      ? { get: columns.find((c) => c.key === sort.key && c.sortValue)?.sortValue, dir: sort.dir }
      : undefined;
    if (spec?.get) {
      const { get, dir } = spec;
      matched.sort((x, y) => {
        const a = get(x);
        const b = get(y);
        if (a === undefined && b === undefined) return 0;
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return compare(a, b) * dir;
      });
    }
    return { rows: matched.slice(0, maxRows), total: matched.length };
  }, [props.items, props.searchText, columns, query, sort, maxRows]);

  useEffect(() => {
    setActive(0);
  }, [query, sort]);

  // Keep the keyboard-active row visible.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open ]);

  function commit(key: string) {
    skipBlur.current = true;
    onChange(key);
    setQuery(props.displayValue?.(key, props.items) ?? key);
    setOpen(false);
    inputRef.current?.blur();
  }

  function toggleSort(key: string) {
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 1 };
      if (s.dir === 1) return { key, dir: -1 };
      return null;
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setActive((a) => Math.min(a + 1, rows.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault();
        if (props.displayValue && !edited.current) {
          // Focus-clear only, nothing typed — Enter keeps the current value.
          setQuery(display);
          setOpen(false);
        } else commit(rows[active] ? props.getKey(rows[active] as T) : query);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery(display);
      setOpen(false);
    }
  }

  return (
    <div className="sw-combo">
      <input
        ref={inputRef}
        className="sw-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder ?? ""}
        value={query}
        onChange={(e) => {
          edited.current = true;
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          // With friendly display text the closed input shows a label, not
          // the key — clear on open so typing filters the full list.
          if (props.displayValue) {
            edited.current = false;
            setQuery("");
          }
          setOpen(true);
        }}
        onBlur={() => {
          if (skipBlur.current) {
            skipBlur.current = false;
            setOpen(false);
            return;
          }
          // Commit free text on the way out (custom ids stay valid);
          // Escape already reverted query, so this is a no-op for it. An
          // untouched focus-clear reverts instead of committing ""; so does
          // a cleared destination ("" is never a valid backend — picking
          // nothing keeps the current one).
          const clearedDestination = props.displayValue !== undefined && query === "";
          if (open && edited.current && query !== value && !clearedDestination) commit(query);
          else {
            setQuery(display);
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
      />
      {open &&
        anchor &&
        createPortal(
          <div
            className="sw-combo-list"
            role="listbox"
            id={listId}
            ref={listRef}
            style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
          >
            {rows.length === 0 ? (
              <p className="sw-combo-empty">{props.emptyText ?? "No matches — custom value kept."}</p>
            ) : (
              <table className="sw-combo-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c.key}
                        data-align={c.align ?? "left"}
                        data-sortable={c.sortValue ? true : undefined}
                        data-sorted={sort?.key === c.key ? (sort.dir === 1 ? "asc" : "desc") : undefined}
                        aria-sort={
                          !c.sortValue
                            ? undefined
                            : sort?.key === c.key
                              ? sort.dir === 1
                                ? "ascending"
                                : "descending"
                              : "none"
                        }
                        onMouseDown={(e) => {
                          if (c.sortValue) e.preventDefault();
                        }}
                        onClick={() => {
                          if (c.sortValue) toggleSort(c.key);
                        }}
                      >
                        {c.header}
                        {c.sortValue && sort?.key === c.key && (
                          <span aria-hidden="true">{sort.dir === 1 ? " ▲" : " ▼"}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item, i) => (
                    <tr
                      key={props.getKey(item)}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={props.getKey(item) === value}
                      data-active={i === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(props.getKey(item))}
                      onMouseEnter={() => setActive(i)}
                    >
                      {columns.map((c) => (
                        <td key={c.key} data-align={c.align ?? "left"}>
                          {c.render(item)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="sw-combo-foot">
              {total} match{total === 1 ? "" : "es"}
              {total > rows.length ? ` · first ${rows.length} shown — keep typing` : ""}
              {props.statusText ? ` · ${props.statusText}` : ""}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}
