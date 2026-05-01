import { ApiError } from '../../../common/errors/api-error';

export class DeadlineNotFoundError extends ApiError {
  constructor(deadlineId: string) {
    super(404, 'DEADLINE_NOT_FOUND', 'Deadline not found', { deadlineId });
  }
}

export class DeadlinePolicyNotFoundError extends ApiError {
  constructor(policyId: string) {
    super(404, 'DEADLINE_POLICY_NOT_FOUND', 'Deadline policy not found', { policyId });
  }
}

export class DeadlineInvalidStatusTransitionError extends ApiError {
  constructor(details: Record<string, unknown>) {
    super(409, 'DEADLINE_INVALID_STATUS_TRANSITION', 'Invalid deadline status transition', details);
  }
}

export function deadlineAdapterUnavailableError(adapter: string): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Deadline adapter is not configured', {
    feature: 'deadlines',
    adapter,
  });
}
