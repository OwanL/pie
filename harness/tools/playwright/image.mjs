import { requirePlaywrightDependency } from './dependency-owner.mjs';
import { createPngImageTools } from '../png-image.mjs';

const { PNG } = requirePlaywrightDependency('pngjs');

export const { pngDimensions, createDisplayPng } = createPngImageTools(PNG, { copyUnscaled: true });
