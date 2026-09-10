// Closed-input text of the design-system Combobox: committed keys that read
// poorly (encoded destinations) render a friendly label via displayValue,
// while model-id keys render raw. Static markup only — the closed input's
// value attribute is set on first render so SSR and hydration agree.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Combobox, type ComboColumn } from "./combobox.js";

interface Item {
  value: string;
  label: string;
}

const columns: ComboColumn<Item>[] = [
  { key: "dest", header: "Destination", render: (o) => o.label },
];

const items: Item[] = [{ value: "key:openrouter:main", label: "E2E key (main)" }];

function render(value: string, displayValue?: (v: string, list: Item[]) => string | undefined) {
  return renderToStaticMarkup(
    <Combobox
      value={value}
      onChange={() => {}}
      items={items}
      getKey={(o) => o.value}
      searchText={(o) => `${o.label} ${o.value}`}
      columns={columns}
      displayValue={displayValue}
    />,
  );
}

const labelFor = (v: string, list: Item[]) => list.find((o) => o.value === v)?.label;

describe("Combobox displayValue", () => {
  it("shows the friendly label for a known key while closed", () => {
    const markup = render("key:openrouter:main", labelFor);
    assert.match(markup, /value="E2E key \(main\)"/);
    assert.doesNotMatch(markup, /key:openrouter:main/);
  });

  it("falls back to the raw key when the value matches no item", () => {
    const markup = render("key:openrouter:gone", labelFor);
    assert.match(markup, /value="key:openrouter:gone"/);
  });

  it("shows the raw key when no displayValue is given", () => {
    const markup = render("key:openrouter:main");
    assert.match(markup, /value="key:openrouter:main"/);
  });
});
