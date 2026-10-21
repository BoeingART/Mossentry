import type { Action, ApprovalBatch, Dashboard } from './types.ts';

export type ApprovalList = ApprovalBatch & { legacy: boolean; items: Action[] };
export function approvalLists(data: Pick<Dashboard, 'actions' | 'approval_batches'>): ApprovalList[] {
  const lists: ApprovalList[] = (data.approval_batches ?? []).map(batch => ({
    ...batch, legacy: false,
    items: data.actions.filter(action => action.batch_id === batch.id).sort((a, b) => a.id - b.id),
  })).filter(batch => batch.items.length > 0);
  for (const item of data.actions.filter(action => action.batch_id == null)) lists.push({
    id: item.id, legacy: true, items: [item], status: item.status,
    created_at: item.requested_at, approved_at: item.approved_at, executed_at: item.executed_at, error: item.error,
  });
  return lists.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}
