import * as http from 'node:http';
import * as vscode from 'vscode';

import { PROXY_MASTER_KEY_ENV } from './session-service/proxy-master-key';

export interface ProxyProviderMetrics {
  provider: string;
  modelInfoId: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrentRequests: number;
  /** Per-provider afterburn window in seconds (0 = disabled). Emitted by the
   *  proxy metrics route for observability; the status strip does not depend on
   *  it. Optional for backward compatibility with proxies that don't emit it. */
  afterburnSeconds?: number;
}

export interface ProxyMetricsServiceDeps {
  onChanged: () => void;
}

const POLL_MS = 1000;

export class ProxyMetricsService {
  private timer?: ReturnType<typeof setInterval>;
  private metrics: ProxyProviderMetrics[] = [];
  private inFlight = false;

  constructor(private readonly deps: ProxyMetricsServiceDeps) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getMetrics(): ProxyProviderMetrics[] {
    return this.metrics;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const next = await this.fetchMetrics();
      if (signature(next) !== signature(this.metrics)) {
        this.metrics = next;
        this.deps.onChanged();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchMetrics(): Promise<ProxyProviderMetrics[]> {
    const useProxy = vscode.workspace.getConfiguration('pie').get<boolean>('useProxy', true);
    if (!useProxy) return [];

    const masterKey = process.env[PROXY_MASTER_KEY_ENV]?.trim();
    if (!masterKey) return [];

    const port = vscode.workspace.getConfiguration('pie').get<number>('proxyPort', 4000);
    const body = await httpGetJson(`http://127.0.0.1:${port}/health/proxy_metrics`, masterKey);
    if (!body || !Array.isArray(body.providers)) return [];

    // Keep idle providers (activeRequests === 0 && queuedRequests === 0) so the
    // proxy status strip stays present between turns instead of flickering
    // appear/disappear as models complete. The proxy's /health/proxy_metrics
    // endpoint already returns every configured provider; dropping idle ones
    // here was what made the UI vanish whenever no request was in flight.
    return body.providers
      .filter((item: any): item is ProxyProviderMetrics => (
        !!item
        && typeof item.provider === 'string'
        && typeof item.modelInfoId === 'string'
        && typeof item.activeRequests === 'number'
        && typeof item.queuedRequests === 'number'
        && typeof item.maxConcurrentRequests === 'number'
      ))
      .sort((left: ProxyProviderMetrics, right: ProxyProviderMetrics) => {
        if (right.queuedRequests !== left.queuedRequests) return right.queuedRequests - left.queuedRequests;
        if (right.activeRequests !== left.activeRequests) return right.activeRequests - left.activeRequests;
        return left.provider.localeCompare(right.provider);
      });
  }
}

function httpGetJson(url: string, masterKey: string): Promise<any | null> {
  return new Promise((resolve) => {
    const req = http.get(url, {
      timeout: 1500,
      headers: {
        Authorization: `Bearer ${masterKey}`,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function signature(metrics: readonly ProxyProviderMetrics[]): string {
  return metrics
    .map((metric) => `${metric.provider}:${metric.modelInfoId}:${metric.activeRequests}:${metric.queuedRequests}:${metric.maxConcurrentRequests}`)
    .join('|');
}
