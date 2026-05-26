export interface DeadlineActionIdempotencyInput {
  deadlineEventId: string;
  actionType: string;
  targetType?: string | null;
  targetId?: string | number | null;
  orderId?: string | number | null;
  actionRuleId?: string | null;
  targetStatusId?: string | number | null;
  snapshotHash?: string | null;
}

export function buildDeadlineActionIdempotencyKey(input: DeadlineActionIdempotencyInput): string {
  const targetType = input.targetType?.trim() || 'none';
  const targetId =
    input.targetId === undefined || input.targetId === null ? 'none' : String(input.targetId);
  const orderId = input.orderId === undefined || input.orderId === null ? 'none' : String(input.orderId);
  const actionRuleId = input.actionRuleId?.trim() || 'none';
  const targetStatusId =
    input.targetStatusId === undefined || input.targetStatusId === null
      ? 'none'
      : String(input.targetStatusId);
  const snapshotHash = input.snapshotHash?.trim() || 'none';

  return `${input.deadlineEventId}:${input.actionType}:${targetType}:${targetId}:order:${orderId}:${actionRuleId}:${targetStatusId}:${snapshotHash}`;
}
