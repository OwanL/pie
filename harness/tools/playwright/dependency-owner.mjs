import { createNativeOwnerRequire } from '../../../scripts/lib/native-owner.mjs';

// Source mode retains the extension-local owner. A packaged launch supplies an
// explicit resolver root inside its validated immutable Playwright payload.
const moduleResolutionRoot = process.env.PIE_PLAYWRIGHT_MODULE_RESOLUTION_ROOT;
export const requirePlaywrightDependency = createNativeOwnerRequire(
  'playwright',
  moduleResolutionRoot === undefined ? {} : { moduleResolutionRoot },
);
