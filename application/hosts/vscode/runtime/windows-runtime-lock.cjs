'use strict';

// Source-only adapter for the startup loader's runtime lock. One authoritative
// library source serves both execution modes:
// - Delivery builds emit the standalone neutral owner bytes into the build
//   output (out/windows-runtime-lock.cjs; its .vscodeignore line ships it in
//   every VSIX), and the packaged module is this adapter's copy inside an
//   installed extension, where no checkout ancestry exists.
// - Inside the checkout (development hosts and tests) the packaged copy may be
//   absent or stale, so the adapter falls back to the checkout-relative
//   authoritative source that fresh delivery builds read the packaged bytes
//   from.
// The packaged-module selection is existence-gated, never require-failure
// gated: a missing packaged module falls back to the authoritative source,
// while any real defect inside a present packaged module surfaces instead of
// silently switching to a different copy.
const fs = require('node:fs');
const path = require('node:path');

const packagedModule = path.join(__dirname, '..', 'out', 'windows-runtime-lock.cjs');
module.exports = require(
  fs.existsSync(packagedModule)
    ? packagedModule
    : '../../../../lib/windows-runtime-lock/windows-runtime-lock.cjs',
);
