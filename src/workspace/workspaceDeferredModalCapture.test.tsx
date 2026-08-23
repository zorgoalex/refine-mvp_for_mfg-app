import React, { useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { authSession } from '../api/authSession';
import {
  captureWorkspaceCheckpoint,
  clearWorkspaceCheckpointRegistry,
  readWorkspaceCheckpointAdapterState,
} from './workspaceCheckpointRegistry';
import { useWorkspaceCheckpointAdapter } from './workspaceCheckpointReact';
import { useDeferredWorkspaceEntity } from './useDeferredWorkspaceEntity';
import { clearWorkspaceUiState, writeWorkspaceUiCheckpoint } from './workspaceUiStateStore';

interface Entity {
  id: number;
}

interface SurfaceCase {
  label: string;
  parentAdapterKey: string;
  modalAdapterKey: string;
  openField: string;
  modeField: string;
  entityKeyField: string;
}

const surfaces: SurfaceCase[] = [
  {
    label: 'detail modal',
    parentAdapterKey: 'order-details-tab',
    modalAdapterKey: 'detail-modal',
    openField: 'detailModalOpen',
    modeField: 'detailModalMode',
    entityKeyField: 'editingDetailKey',
  },
  {
    label: 'payment modal',
    parentAdapterKey: 'order-payments-tab',
    modalAdapterKey: 'payment-modal',
    openField: 'paymentModalOpen',
    modeField: 'paymentModalMode',
    entityKeyField: 'editingPaymentKey',
  },
];

function DeferredModalHarness({ surface }: { surface: SurfaceCase }) {
  const workspaceKey = '/orders/edit/42';
  const restored = useRef(
    readWorkspaceCheckpointAdapterState(workspaceKey, surface.parentAdapterKey),
  ).current;
  const deferred = useDeferredWorkspaceEntity({
    restoreRequested: restored?.[surface.openField] === true
      && restored?.[surface.modeField] === 'edit',
    restoredKey: typeof restored?.[surface.entityKeyField] === 'number'
      ? restored[surface.entityKeyField]
      : null,
    entities: [] as Entity[],
    getKey: (entity: Entity) => entity.id,
  });

  useWorkspaceCheckpointAdapter(workspaceKey, surface.parentAdapterKey, {
    canCapture: () => !deferred.restorePending,
    capture: () => ({
      [surface.openField]: false,
      [surface.modeField]: 'edit',
      [surface.entityKeyField]: null,
    }),
  });
  return null;
}

describe('deferred modal checkpoint capture', () => {
  beforeEach(() => {
    authSession.clear();
    authSession.setUser({ id: 'A', username: 'a', role: 'admin', permissions: ['orders.view'] });
    clearWorkspaceCheckpointRegistry();
    clearWorkspaceUiState();
  });

  it.each(surfaces)(
    'preserves $label open/key/form on route switch before row arrival',
    async (surface) => {
      const workspaceKey = '/orders/edit/42';
      const parentState = {
        [surface.openField]: true,
        [surface.modeField]: 'edit',
        [surface.entityKeyField]: 7,
      };
      const modalState = {
        open: true,
        mode: 'edit',
        form: { values: { notes: 'retained draft' }, touched: ['notes'] },
      };
      writeWorkspaceUiCheckpoint(workspaceKey, {
        schemaVersion: 1,
        adapters: {
          [surface.parentAdapterKey]: parentState,
          [surface.modalAdapterKey]: modalState,
        },
      });

      let view!: ReturnType<typeof TestRenderer.create>;
      await act(async () => {
        view = TestRenderer.create(<DeferredModalHarness surface={surface} />);
      });

      expect(captureWorkspaceCheckpoint(workspaceKey)).toBe(false);
      expect(readWorkspaceCheckpointAdapterState(workspaceKey, surface.parentAdapterKey))
        .toEqual(parentState);
      expect(readWorkspaceCheckpointAdapterState(workspaceKey, surface.modalAdapterKey))
        .toEqual(modalState);

      await act(async () => view.unmount());
    },
  );
});
