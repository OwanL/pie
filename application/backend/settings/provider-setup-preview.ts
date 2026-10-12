import { providerProtocolOptions, type ProviderConfig } from '../../../harness/model-providers/catalog/provider-config';
import type { ProviderModelList } from '../../../harness/model-providers/catalog/provider-model-resolution';
import type { ProviderSetupDraft, ProviderSetupPreviewView } from '../../lib/protocol/provider-setup-preview';
// Compatibility projection; pure draft and save preparation are domain-owned.
export { createProviderSetupDraft, prepareProviderSetupSave, type PreparedProviderSetupSave } from '../../../harness/model-providers/management/drafts';
const own = <T>(record: Record<string, T> | Readonly<Record<string, T>> | undefined, id: string): T | undefined =>
  record && Object.hasOwn(record, id) ? record[id] : undefined;
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
  }
  return value;
}

export function projectProviderSetupPreview(config: ProviderConfig, resolvedList: ProviderModelList,
  draft: ProviderSetupDraft | null, status: ProviderSetupPreviewView['status'] = 'idle',
  message?: string, issues?: ProviderSetupPreviewView['issues']): ProviderSetupPreviewView {
  const ids = [...new Set([...Object.keys(config.providers), ...Object.keys(resolvedList.providers)])].sort();
  return { mode: 'preview', providers: ids.map(id => ({ id, configured: !!own(config.providers, id),
    enabled: own(config.providers, id)?.enabled === true,
    modelCount: Object.keys(own(resolvedList.providers, id)?.models ?? {}).length })),
  protocols: providerProtocolOptions, draft: clone(draft), status,
  ...(message === undefined ? {} : { message }), ...(issues === undefined ? {} : { issues: clone(issues) }) };
}

