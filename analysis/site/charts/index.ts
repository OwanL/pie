import type { ChartEntry } from '../lib.ts';
import { costCharts } from './cost.ts';
import { efficiencyCharts } from './efficiency.ts';
import { insightsCharts } from './insights.ts';
import { attributionCharts } from './attribution.ts';
import { toolDurationCharts } from './toolduration.ts';
import { pruningCharts } from './pruning.ts';
import { errorCharts } from './errors.ts';
import { fileTypeCharts } from './filetypes.ts';
import { interruptionCharts } from './interruptions.ts';
import { inputCharts } from './inputs.ts';
import { questionCharts } from './questions.ts';
import { settingsCharts } from './settings.ts';
import { throughputCharts } from './throughput.ts';
import { promptSizeCharts } from './promptsize.ts';

/**
 * Registry of all analytics charts added in the gap-analysis pass.
 *
 * Each entry is a self-contained {@link ChartEntry} that receives a
 * {@link ChartContext} (filtered runs, tool-usage rows, pruning / backend-error
 * / file-type datasets, and the shared renderSpec/setNote helpers). Entries are
 * rendered via `renderChartEntries`, which isolates failures so one chart
 * cannot abort the rest of the render pass.
 */
export const newCharts: ChartEntry[] = [
  ...costCharts,
  ...efficiencyCharts,
  ...attributionCharts,
  ...insightsCharts,
  ...throughputCharts,
  ...toolDurationCharts,
  ...pruningCharts,
  ...errorCharts,
  ...fileTypeCharts,
  ...interruptionCharts,
  ...inputCharts,
  ...questionCharts,
  ...settingsCharts,
  ...promptSizeCharts,
];
