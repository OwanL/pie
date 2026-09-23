import { createUuidV4 } from './uuid';

export type LocalMessageKind = 'send' | 'edit';

export function createLocalMessageId(kind: LocalMessageKind = 'send'): string {
  const prefix = kind === 'edit' ? 'local:edit' : 'local';
  return `${prefix}:${createUuidV4()}`;
}
