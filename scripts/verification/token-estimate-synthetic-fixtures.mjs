// Frozen holdout copied from OS-temp schema-structural-probe.cjs; no expected
// counts or estimator serialization is used to construct this schema.
const obj = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const str = (description) => ({ type: 'string', description });
export const holdoutSchema = obj({ jobs: { type: 'array', description: 'Ordered processing jobs.', items: obj({ operation: { type: 'string', description: 'Operation.', enum: ['insert', 'delete', 'replace'] }, target: obj({ path: str('Relative path.'), recursive: { type: 'boolean', description: 'Include descendants.' } }, ['path'], { additionalProperties: false }) }, ['operation', 'target'], { additionalProperties: false }) }, dry_run: { type: 'boolean', description: 'Preview without writing.' } }, ['jobs'], { additionalProperties: false });

export function measurementError(estimated, observed) {
  if (observed === null) return { absolute: null, relative: null, pass: null };
  const absolute = Math.abs(estimated - observed);
  const relative = observed === 0 ? (absolute === 0 ? 0 : null) : absolute / Math.abs(observed);
  return { absolute, relative, pass: absolute <= 16 || (relative !== null && relative <= 0.1) };
}

// Frozen candidate-holdout generators: they reproduce, unmodified, the fixture
// shapes of the recorded OS-temp schema-candidate-holdout probe (fresh_*)
// tools. The frozen usage observations below were measured afterwards on the
// recorded provider route and never influenced the schema shapes.
const holdoutObject = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const holdoutEnum = (size) => ({ type: 'string', enum: Array.from({ length: size }, (_, i) => `choice_${i}_variant`), description: 'Choose one supported variant.' });
export const holdoutDeep = (depth) => depth
  ? holdoutObject({ node: { type: 'array', description: 'Child records at this level.', items: holdoutDeep(depth - 1) }, status: holdoutEnum(6), note: { type: 'string', description: 'Optional human-readable note.' } }, ['node'])
  : holdoutObject({ id: { type: 'string' }, weight: { type: 'number' }, tags: { type: 'array', items: holdoutEnum(5) } }, ['id']);
const holdoutTool = (name, parameters) => ({ name, description: 'Inspect generated synthetic data.', parameters });
export const candidateHoldoutFixtures = {
  baseline: [],
  'wide-deep150': [holdoutTool('fresh_wide_deep', holdoutObject(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`branch_${i}`, holdoutDeep(3)]))))],
  multitool18: Array.from({ length: 18 }, (_, i) => holdoutTool(`fresh_tool_${i}`, holdoutDeep(i % 5))),
  'enum-heavy50': [holdoutTool('fresh_enumerations', holdoutObject(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`selection_${i}`, holdoutEnum(32)]))))],
  deep12: [holdoutTool('fresh_deep_twelve', holdoutDeep(12))],
};

// Nested70 fixture from the recorded provider-probe removal pair
// [small, nested70] -> [small]; the pair delta isolates the nested schema.
export const nested70Tool = { name: 'synthetic_nested', description: 'Inspect synthetic records.', parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`record_${i}`, { type: 'object', description: `Synthetic record ${i} metadata`, properties: { label: { type: 'string', enum: ['alpha', 'beta', 'gamma'] }, values: { type: 'array', items: { type: 'number' } } } }])) } };
export const probeSmallTool = { name: 'synthetic_lookup', description: 'Look up a synthetic value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false } };

// Small frozen measured manifest (no large JSON is copied into the repo).
// Observed usage was recorded on one gpt-6-astra openai-codex route with
// identical framing subtracted; it is provider-specific measured evidence,
// not exact ground-truth constants across models.
//   'wide-deep150', 'multitool18', 'enum-heavy50', 'deep12': candidate-holdout
//     request totals minus the same-prompt baseline request total.
//   nested70: recorded removal-pair usage delta [small, nested70] -> [small].
export const frozenProviderMeasurements = {
  route: { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' },
  'wide-deep150': 40835,
  multitool18: 3637,
  'enum-heavy50': 11634,
  deep12: 940,
  nested70: 2045,
};
// JSON-string fingerprint lengths of the generated fixture cores; a frozen
// guard that the generators still build the exact recorded shapes.
export const frozenFixtureCoreLengths = { wideDeep150: 243115, enumHeavy50: 35965, deep12: 5441, nested70: 14096 };
