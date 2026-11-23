#!/usr/bin/env node
// Committed launcher so npm can link the `tejun` command before the first build.
// Run `npm run build` first; the real entry point is compiled to dist/index.js.
import "../dist/index.js";
