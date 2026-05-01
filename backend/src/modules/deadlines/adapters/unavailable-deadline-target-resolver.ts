import { deadlineAdapterUnavailableError } from '../errors/deadline.errors';
import type { DeadlineTargetRef, DeadlineTargetResolverPort, DeadlineTargetState } from '../application/deadline.types';
import type { DeadlineActionType } from '../domain/deadline-actions';

export class UnavailableDeadlineTargetResolver implements DeadlineTargetResolverPort {
  async resolveTargetState(_input: DeadlineTargetRef): Promise<DeadlineTargetState> {
    throw deadlineAdapterUnavailableError('deadline_target_resolver');
  }

  async canApplyAction(_input: {
    actionType: DeadlineActionType;
    target: DeadlineTargetRef;
  }): Promise<boolean> {
    throw deadlineAdapterUnavailableError('deadline_target_resolver');
  }
}
