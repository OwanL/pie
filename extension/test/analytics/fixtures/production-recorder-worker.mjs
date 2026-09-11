// Exercise the production recorder worker source without depending on a
// previously generated extension/out tree. AnalyticsRecorderSupervisor owns
// this disposable child exactly as it owns the packaged worker. The parent
// supplies the repository-owned tsx loader explicitly; no arbitrary parent
// process flags are inherited by the dedicated helper.
await import('../../../src/analytics/recorder-worker-entry.ts');
