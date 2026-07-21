// Lazy composition root for the wizard. This is the ONLY module allowed to
// import adapters/ui, and it is reached only through the dynamic import in
// src/cli.js — never from the launch path.
//
// build.js bundles this file to dist/ui.js.

export { App, ModelPicker, ProfilePicker, runUi } from '../adapters/ui/index.jsx'
