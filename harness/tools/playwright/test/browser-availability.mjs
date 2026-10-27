import { existsSync } from 'node:fs';

import { requirePlaywrightDependency } from '../dependency-owner.mjs';

const { chromium } = requirePlaywrightDependency('playwright');

// This controls whether browser-dependent tests are eligible to run; it does
// not prove that a browser can launch. Shell-only environments can explicitly
// opt in with PIE_RUN_PLAYWRIGHT_TESTS=1, in which case tests may fail if the
// browser is missing. Discovery never launches or probes a browser.
export function shouldRunBrowserTests({ optIn, fullBrowserExecutableExists }) {
  return optIn || fullBrowserExecutableExists;
}

export function browserTestsEligible() {
  if (process.env.PIE_RUN_PLAYWRIGHT_TESTS === '1') return true;

  let fullBrowserExecutableExists = false;
  try { fullBrowserExecutableExists = existsSync(chromium.executablePath()); }
  catch { /* an unresolvable full-browser path is not default eligibility */ }

  return shouldRunBrowserTests({ optIn: false, fullBrowserExecutableExists });
}
