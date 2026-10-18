import { requireComputerUseDependency } from './dependency-owner.mjs';
import { createPngImageTools } from '../png-image.mjs';

const { PNG } = requireComputerUseDependency('pngjs');

export const { pngDimensions, createDisplayPng } = createPngImageTools(PNG);
