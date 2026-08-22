import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useDeferredWorkspaceEditingKey } from './useDeferredWorkspaceEditingKey';

interface Entity {
  id: number;
}

interface Snapshot {
  editingKey: string | number | null;
  restorePending: boolean;
  restoredActive: boolean;
  isEditing: boolean;
  applyCurrentEdits: () => boolean;
  setEditingKey: (key: string | number | null) => void;
}

function Harness({
  entities,
  onSnapshot,
}: {
  entities: Entity[];
  onSnapshot: (snapshot: Snapshot) => void;
}) {
  const state = useDeferredWorkspaceEditingKey({
    restoredKey: 7,
    entities,
    getKey: (entity) => entity.id,
  });
  onSnapshot({
    ...state,
    isEditing: state.restorePending || state.editingKey !== null,
    applyCurrentEdits: () => state.canApplyCurrentEdit,
  });
  return null;
}

describe('deferred workspace inline edit restore', () => {
  it('blocks inline save until matching async row arrives', async () => {
    let latest!: Snapshot;
    let view!: ReturnType<typeof TestRenderer.create>;
    const onSnapshot = (snapshot: Snapshot) => {
      latest = snapshot;
    };

    await act(async () => {
      view = TestRenderer.create(<Harness entities={[]} onSnapshot={onSnapshot} />);
    });
    expect(latest).toMatchObject({
      editingKey: null,
      restorePending: true,
      restoredActive: false,
      isEditing: true,
    });
    expect(latest.applyCurrentEdits()).toBe(false);

    await act(async () => {
      view.update(<Harness entities={[{ id: 7 }]} onSnapshot={onSnapshot} />);
    });
    expect(latest).toMatchObject({
      editingKey: 7,
      restorePending: false,
      restoredActive: true,
      isEditing: true,
    });
    expect(latest.applyCurrentEdits()).toBe(true);
    await act(async () => view.unmount());
  });

  it('does not resurrect restored edit after explicit cancel', async () => {
    let latest!: Snapshot;
    let view!: ReturnType<typeof TestRenderer.create>;
    const onSnapshot = (snapshot: Snapshot) => {
      latest = snapshot;
    };

    await act(async () => {
      view = TestRenderer.create(<Harness entities={[]} onSnapshot={onSnapshot} />);
    });
    await act(async () => latest.setEditingKey(null));
    await act(async () => {
      view.update(<Harness entities={[{ id: 7 }]} onSnapshot={onSnapshot} />);
    });

    expect(latest).toMatchObject({
      editingKey: null,
      restorePending: false,
      restoredActive: false,
      isEditing: false,
    });
    expect(latest.applyCurrentEdits()).toBe(true);
    await act(async () => view.unmount());
  });
});
