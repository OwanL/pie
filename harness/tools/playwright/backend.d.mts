import type { EventBundle, ObservationResult, RuntimeResponse } from './types.js';

interface PlaywrightSession {
  id: string;
  browser?: { close(): Promise<void> };
  browserServer?: {
    close(): Promise<void>;
    process(): object | undefined;
  };
  [key: string]: unknown;
}

type BackendResponse = RuntimeResponse & {
  observation?: ObservationResult & { snapshot?: string };
  closed?: { scope: 'session' | 'runtime'; sessionIds: string[]; omittedSessionIds?: number };
  sidecarPid?: number;
  browserPids?: number[];
};

export declare class PlaywrightBackend {
  constructor(options?: Record<string, unknown>);

  readonly sessions: Map<string, PlaywrightSession>;
  readonly closingSessions: Set<PlaywrightSession>;
  readonly closeGraceMs: number;
  [key: string]: unknown;

  handle(method: 'open', params: { observation?: { mode?: 'auto' | 'full' }; [key: string]: unknown }, signal?: AbortSignal): Promise<BackendResponse & { observation: ObservationResult & { snapshot: string } }>;
  handle(method: 'close', params: Record<string, unknown>, signal?: AbortSignal): Promise<BackendResponse & { closed: NonNullable<RuntimeResponse['closed']> }>;
  handle(method: 'debug_pids', params: Record<string, unknown>, signal?: AbortSignal): Promise<BackendResponse & { sidecarPid: number; browserPids: number[] }>;
  handle(method: 'act', params: Record<string, unknown>, signal?: AbortSignal): Promise<BackendResponse & { observation: ObservationResult & { snapshot: string } }>;
  handle(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<BackendResponse>;
  shutdown(): Promise<void>;
  forceKillAll(): Promise<void>;
  makeSession(id: string, params: { artifactDir: string; [key: string]: unknown }): PlaywrightSession;
  closeSession(session: PlaywrightSession, force?: boolean): Promise<void>;
  finishClosedSession(session: PlaywrightSession): void;
  pushEvent(session: PlaywrightSession, queue: keyof EventBundle, entry: Record<string, unknown>): void;
  collectEvents(session: PlaywrightSession, settings?: Record<string, unknown>): EventBundle;
}
