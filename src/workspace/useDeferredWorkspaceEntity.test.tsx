import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useDeferredWorkspaceEntity } from './useDeferredWorkspaceEntity';

interface Entity {
  id: number;
  name: string;
}

interface Snapshot {
  entity?: Entity;
  restoreReady: boolean;
  restorePending: boolean;
  cancelDeferredRestore: () => void;
}

function Harness({
  entities,
  onSnapshot,
}: {
  entities: Entity[];
  onSnapshot: (snapshot: Snapshot) => void;
}) {
  const state = useDeferredWorkspaceEntity({
    restoreRequested: true,
    restoredKey: 7,
    entities,
    getKey: (entity) => entity.id,
  });
  onSnapshot({
    entity: state.entity,
    restoreReady: state.restoreReady,
    restorePending: state.restorePending,
    cancelDeferredRestore: state.cancelDeferredRestore,
  });
  return null;
}

describe('deferred workspace entity restore', () => {
  it('keeps edit restore closed until matching async entity arrives', async () => {
    let latest: Snapshot | undefined;
    let view!: ReturnType<typeof TestRenderer.create>;
    const onSnapshot = (snapshot: Snapshot) => {
      latest = snapshot;
    };

    await act(async () => {
      view = TestRenderer.create(<Harness entities={[]} onSnapshot={onSnapshot} />);
    });
    expect(latest).toMatchObject({
      entity: undefined,
      restoreReady: false,
      restorePending: true,
    });

    await act(async () => {
      view.update(
        <Harness
          entities={[{ id: 7, name: 'restored' }]}
          onSnapshot={onSnapshot}
        />,
      );
    });
    expect(latest).toMatchObject({
      entity: { id: 7, name: 'restored' },
      restoreReady: true,
      restorePending: false,
    });
    await act(async () => view.unmount());
  });

  it('does not resurrect a deferred restore after explicit cancel', async () => {
    let latest!: Snapshot;
    let view!: ReturnType<typeof TestRenderer.create>;
    const onSnapshot = (snapshot: Snapshot) => {
      latest = snapshot;
    };

    await act(async () => {
      view = TestRenderer.create(<Harness entities={[]} onSnapshot={onSnapshot} />);
    });
    await act(async () => latest.cancelDeferredRestore());
    await act(async () => {
      view.update(
        <Harness entities={[{ id: 7, name: 'late' }]} onSnapshot={onSnapshot} />,
      );
    });

    expect(latest).toMatchObject({
      entity: undefined,
      restoreReady: false,
      restorePending: false,
    });
    await act(async () => view.unmount());
  });
});
