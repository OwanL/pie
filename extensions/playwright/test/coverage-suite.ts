export {};

// Release-coverage entrypoint. Import the ordinary test files into one TSX
// process so Node's experimental coverage does not race separate source-map
// records for the same extension modules. Fast development runs continue to
// discover the individual *.test.ts files and use the two-batch plan.
await import('./artifacts.test.js');
await import('./backend.test.js');
await import('./browser-smoke.test.js');
await import('./extension.test.js');
// Node recursively folds the embedded-loader child process's alternate jiti
// source maps into experimental coverage. Skip only that external compatibility
// probe here; ordinary fast/root suites still execute it.
process.env.PLAYWRIGHT_COVERAGE_RUN = '1';
await import('./host-runtime-integration.test.js');
delete process.env.PLAYWRIGHT_COVERAGE_RUN;
await import('./lifecycle.test.js');
await import('./protocol.test.js');
await import('./result.test.js');
await import('./runtime-client.test.js');
await import('./schema.test.js');
await import('./tool-dogfood.test.js');
await import('./validation.test.js');
