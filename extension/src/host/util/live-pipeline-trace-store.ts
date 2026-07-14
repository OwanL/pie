// Compatibility re-export. The Node store is shared by host and backend; the
// webview never imports this Node-only module.
export * from '../../shared/live-pipeline-trace-store.js';
