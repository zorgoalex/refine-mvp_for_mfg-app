export interface DeadlineActionIdempotencyInput {
  deadlineEventId: string;
  actionType: string;
  targetType?: string | null;
  targetId?: string | number | null;
}

export function buildDeadlineActionIdempotencyKey(input: DeadlineActionIdempotencyInput): string {
  const targetType = input.targetType?.trim() || 'none';
  const targetId =
    input.targetId === undefined || input.targetId === null ? 'none' : String(input.targetId);

  return `${input.deadlineEventId}:${input.actionType}:${targetType}:${targetId}`;
}
