import type { ChatMessage, ModelInfo, ProxySessionStatus } from '../shared/protocol';
import type { ArchState } from './core/arch-state';

export interface ProxyProviderLoad {
  provider: string;
  activeSessions: number;
  queuedSessions: number;
  maxConcurrentRequests: number;
  maxedOut: boolean;
}

export interface ProxyOverview {
  loads: ProxyProviderLoad[];
  bySession: Record<string, ProxySessionStatus>;
}

interface ProviderCandidate {
  sessionPath: string;
  waitingForProvider: boolean;
  transcriptLoaded: boolean;
}

function countRunningToolCalls(messages?: ChatMessage[]): number {
  if (!messages) return 0;
  let count = 0;
  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const tc of message.toolCalls) {
        if (tc.status === 'running') count += 1;
      }
      continue;
    }
    if (!message.parts) continue;
    for (const part of message.parts) {
      if (part.kind === 'toolCall' && part.toolCall.status === 'running') {
        count += 1;
      }
    }
  }
  return count;
}

function resolveProviderForModel(
  availableModelsBySession: Record<string, ModelInfo[]>,
  sessionPath: string,
  modelId?: string,
): string | undefined {
  if (!modelId) return undefined;

  const localMatch = availableModelsBySession[sessionPath]?.find((model) => model.id === modelId);
  if (localMatch?.provider) {
    return localMatch.provider;
  }

  for (const models of Object.values(availableModelsBySession)) {
    const match = models.find((model) => model.id === modelId);
    if (match?.provider) {
      return match.provider;
    }
  }

  return undefined;
}

function latestUserIndex(transcript: readonly ChatMessage[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function sessionLooksWaitingForProvider(messages?: ChatMessage[]): boolean {
  if (!messages || messages.length === 0) {
    return false;
  }

  const userIndex = latestUserIndex(messages);
  if (userIndex === -1) {
    return false;
  }

  for (let index = userIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === 'assistant') {
      return false;
    }
  }

  return true;
}

function queuePriority(candidate: ProviderCandidate): number {
  if (candidate.transcriptLoaded && candidate.waitingForProvider) {
    return 0;
  }
  if (!candidate.transcriptLoaded) {
    return 1;
  }
  return 2;
}

/**
 * Approximate proxy load by counting currently-running sessions whose active
 * model belongs to a proxied provider and which are not presently inside a
 * running tool call. Sessions beyond a provider's configured concurrency cap
 * are marked as `queued`, preferring ones whose current turn has not yet
 * started an assistant reply (the strongest local signal that they are parked
 * waiting for a proxy slot).
 */
export function getProxyOverview(
  state: ArchState,
  options?: { proxyEnabled?: boolean },
): ProxyOverview {
  if (options?.proxyEnabled === false) {
    return { loads: [], bySession: {} };
  }

  const proxiedProviders = state.settings.proxySettings.providers;
  const sessionByPath = new Map(state.sessions.sessions.map((session) => [session.path, session]));
  const candidatesByProvider = new Map<string, ProviderCandidate[]>();

  for (const sessionPath of state.sessions.runningSessionPaths) {
    const session = sessionByPath.get(sessionPath);
    const provider = resolveProviderForModel(
      state.settings.availableModelsBySession,
      sessionPath,
      session?.modelId,
    );
    if (!provider || !proxiedProviders[provider]) {
      continue;
    }

    const messages = state.transcript.bySession[sessionPath];
    if (messages && countRunningToolCalls(messages) > 0) {
      continue;
    }

    const list = candidatesByProvider.get(provider) ?? [];
    list.push({
      sessionPath,
      waitingForProvider: sessionLooksWaitingForProvider(messages),
      transcriptLoaded: Array.isArray(messages),
    });
    candidatesByProvider.set(provider, list);
  }

  const bySession: Record<string, ProxySessionStatus> = {};
  const loads = [...candidatesByProvider.entries()]
    .map(([provider, candidates]) => {
      const maxConcurrentRequests = Math.max(1, proxiedProviders[provider]?.maxConcurrentRequests ?? 1);
      const activeSessions = Math.min(candidates.length, maxConcurrentRequests);
      const queuedSessions = Math.max(0, candidates.length - maxConcurrentRequests);
      const queuedPaths = new Set(
        [...candidates]
          .sort((left, right) => {
            const delta = queuePriority(left) - queuePriority(right);
            if (delta !== 0) return delta;
            return left.sessionPath.localeCompare(right.sessionPath);
          })
          .slice(0, queuedSessions)
          .map((candidate) => candidate.sessionPath),
      );

      for (const candidate of candidates) {
        bySession[candidate.sessionPath] = {
          provider,
          state: queuedPaths.has(candidate.sessionPath) ? 'queued' : 'active',
          activeSessions,
          queuedSessions,
          maxConcurrentRequests,
        };
      }

      return {
        provider,
        activeSessions,
        queuedSessions,
        maxConcurrentRequests,
        maxedOut: activeSessions >= maxConcurrentRequests,
      } satisfies ProxyProviderLoad;
    })
    .sort((left, right) => {
      if (right.queuedSessions !== left.queuedSessions) {
        return right.queuedSessions - left.queuedSessions;
      }
      if (right.activeSessions !== left.activeSessions) {
        return right.activeSessions - left.activeSessions;
      }
      return left.provider.localeCompare(right.provider);
    });

  return { loads, bySession };
}

export function formatProxyLoadSummary(loads: readonly ProxyProviderLoad[]): string | null {
  if (loads.length === 0) {
    return null;
  }

  return `proxy ${loads
    .map((load) => {
      const base = `${load.provider} ${load.activeSessions}/${load.maxConcurrentRequests}${load.maxedOut && load.queuedSessions === 0 ? '!' : ''}`;
      return load.queuedSessions > 0 ? `${base} +${load.queuedSessions}q` : base;
    })
    .join(', ')}`;
}

export function buildProxyLoadTooltipLines(loads: readonly ProxyProviderLoad[]): string[] {
  if (loads.length === 0) {
    return [];
  }

  return [
    'Proxy load:',
    ...loads.map((load) => {
      const suffix = load.queuedSessions > 0
        ? ` · ${load.queuedSessions} queued`
        : load.maxedOut
          ? ' (maxed)'
          : '';
      return `• ${load.provider}: ${load.activeSessions}/${load.maxConcurrentRequests}${suffix}`;
    }),
  ];
}
