import { createNativeOwnerRequire } from '../../scripts/lib/native-owner.mjs';

// Browser/runtime packages remain installed and locked by extensions/playwright.
export const requirePlaywrightDependency = createNativeOwnerRequire('playwright');
