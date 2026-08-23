import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../../../api/authSession';
import type { CutJobDto } from '../../../api/types/cutApi.types';
import type { UserIdentity } from '../../../types/auth';
import {
  clearWorkspaceOperationPins,
  runPageOwnedWorkspaceOperation,
  WorkspaceOperationOwnershipLostError,
} from '../../../workspace/workspaceOperationPins';
import { executeAddToCutWorkflow } from './AddToCutModal';

const actor = (id: number): UserIdentity => ({
  id: String(id),
  username: `actor-${id}`,
  role: 'manager',
  permissions: ['orders.update'],
});

describe('add-to-cut auth ownership', () => {
  beforeEach(() => {
    clearWorkspaceOperationPins();
    authSession.clear();
    authSession.setUser(actor(1));
    vi.clearAllMocks();
  });

  it('does not continue the real cut request chain after A→B', async () => {
    let resolveCreate!: (job: CutJobDto) => void;
    const api = {
      create: vi.fn(() => new Promise<CutJobDto>((resolve) => {
        resolveCreate = resolve;
      })),
      get: vi.fn(),
      listEligibleDetails: vi.fn(),
      archive: vi.fn(),
      addItems: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof executeAddToCutWorkflow>[2]>;
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-add-to-cut',
      (owner) => executeAddToCutWorkflow({
        mode: 'new',
        name: 'A-42',
        orderIds: [42],
        targetJobId: null,
      }, owner, api),
    );
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());

    authSession.setUser(actor(2));
    resolveCreate({ cutJobId: 7, version: 1 } as CutJobDto);

    await expect(operation).rejects.toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(api.listEligibleDetails).not.toHaveBeenCalled();
    expect(api.addItems).not.toHaveBeenCalled();
    expect(api.archive).not.toHaveBeenCalled();
  });
});
