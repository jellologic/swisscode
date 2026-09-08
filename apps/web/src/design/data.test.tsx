import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Disclosure, Pre } from "./data.js";

describe("Disclosure", () => {
  it("does not render its children while closed", () => {
    // A closed <details> still renders its subtree, and on /proxy those
    // subtrees are whole request/response bodies — megabytes of hidden <pre>.
    const markup = renderToStaticMarkup(
      <Disclosure summary={<span>Request body</span>}>
        <Pre>{"HEAVY-BODY-PAYLOAD"}</Pre>
      </Disclosure>,
    );
    assert.match(markup, /Request body/);
    assert.doesNotMatch(markup, /HEAVY-BODY-PAYLOAD/);
  });
});
