import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../metadata/session-name';
import { textFromSessionMessageContent } from '../metadata/session-metadata';
import { parseJsonOrThrow, toErrorMessage } from '../../../lib/structured-logging/error-message';
import type { SessionSummary } from '../../agent-processes/lib/rpc/session-events.js';
import { summarizeSession, type SessionEntryLike } from '../transcripts/transcript';
import { backendTrace } from '../../../lib/structured-logging/backend-log';
import { backendSessionPathKey } from './session-directory';
import type { SdkModule, SdkSessionInfo } from '../../agent-processes/lib/sdk-integration/sdk';

export async function deriveNameFromFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = parseJsonOrThrow<SessionEntryLike>(line, `session metadata line ${i + 1}`);
        if (entry.type === 'message' && entry.message?.role === 'user') {
          const derived = deriveSessionNameFromText(
            textFromSessionMessageContent(entry.message.content),
          );
          if (derived.name !== NEW_SESSION_NAME) {
            return derived.name;
          }
        }
      } catch (error) {
        backendTrace('sessionMetadata', 'deriveName.lineParseFailed', { level: 'warn', error: toErrorMessage(error), line: i + 1 });
      }
    }
  } catch (error) {
    backendTrace('sessionMetadata', 'deriveName.readFailed', { level: 'warn', error: toErrorMessage(error), filePath });
  }
  return NEW_SESSION_NAME;
}

async function deriveSessionInfoName(session: SdkSessionInfo): Promise<string> {
  const firstMessage = session.firstMessage?.trim();
  if (firstMessage === '(no messages)') return NEW_SESSION_NAME;
  if (firstMessage) return deriveSessionNameFromText(firstMessage).name;
  return await deriveNameFromFile(session.path);
}

export async function discoverSessionSummaries(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  let configuredDirs: string[] = [];
  if (sessionDir) {
    configuredDirs = [sessionDir];
    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true });
      configuredDirs.push(...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(sessionDir, entry.name)));
    } catch {
      // A missing/unreadable configured directory still lists its top-level
      // path via listAll(sessionDir) below; canonical-only sources no longer
      // fall back to the SDK default while a root is configured.
    }
  }
  // Canonical-only listing: with a configured session directory, read it
  // (plus its per-cwd subdirectories) exclusively — the installer's verified
  // migration moved legacy sessions into the canonical store, and `npm run
  // doctor` surfaces any newly stranded legacy sessions rather than scanning
  // the legacy root forever. With nothing configured, the embedded SDK keeps
  // its own default via the bare listAll().
  const sources = await Promise.all(
    configuredDirs.length > 0
      ? configuredDirs.map((dir) => sdk.SessionManager.listAll(dir))
      : [sdk.SessionManager.listAll()],
  );
  const byPath = new Map<string, SdkSessionInfo>();
  for (const session of sources.flat()) {
    const key = backendSessionPathKey(session.path);
    if (!byPath.has(key)) byPath.set(key, session);
  }
  const sessions = [...byPath.values()];
  const summaries = await Promise.all(
    sessions.map(async (session) => {
      const summary = summarizeSession(session);
      if (summary.name === NEW_SESSION_NAME && session.path) {
        const derived = await deriveSessionInfoName(session);
        if (derived !== NEW_SESSION_NAME) {
          summary.name = derived;
          summary.isPlaceholder = true;
        } else {
          summary.isPlaceholder = true;
        }
      }
      return summary;
    }),
  );
  return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function listSessions(
  sdk: SdkModule,
  sessionDir?: string,
): Promise<SessionSummary[]> {
  return await discoverSessionSummaries(sdk, sessionDir);
}
