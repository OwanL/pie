function directiveSources(policy: string, name: string): string[] | null {
  for (const directive of policy.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === name) return parts.slice(1).map((part) => part.toLowerCase());
  }
  return null;
}

/**
 * Whether the document policy can start Pie's same-origin context worker.
 *
 * During a local extension update the browser server can expose a fresh JS
 * bundle before VS Code reloads the older host process. That old CSP has only
 * a nonce-based script-src, which rejects module workers and produces an error
 * on every context revision. Detect the policy up front and use the existing
 * main-thread fallback quietly until the host is reloaded.
 */
export function allowsContextBreakdownWorker(policy: string | null): boolean {
  if (!policy) return true;
  const workerSources = directiveSources(policy, 'worker-src');
  if (workerSources) return !workerSources.includes("'none'") && workerSources.length > 0;

  for (const fallback of ['child-src', 'script-src', 'default-src']) {
    const sources = directiveSources(policy, fallback);
    if (!sources) continue;
    return sources.some((source) => source === "'self'" || source === 'blob:' || source === '*');
  }
  return true;
}

export function documentAllowsContextBreakdownWorker(): boolean {
  if (typeof document === 'undefined') return true;
  const policy = document
    .querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
    ?.content ?? null;
  return allowsContextBreakdownWorker(policy);
}
