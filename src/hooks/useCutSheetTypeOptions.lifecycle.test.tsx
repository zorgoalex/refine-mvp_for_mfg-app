import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const state = {
    active: true,
    authNamespace: 'actor:a',
    generation: 1,
    resourceScope: 'cut-sheet-type-options',
  };
  return {
    state,
    listSheetTypes: vi.fn(),
    capture: () => (
      state.active
        ? {
            authNamespace: state.authNamespace,
            generation: state.generation,
            resourceScope: state.resourceScope,
          }
        : null
    ),
    isCurrent: (token: {
      authNamespace: string;
      generation: number;
      resourceScope: string;
    }) => (
      state.active
      && token.authNamespace === state.authNamespace
      && token.generation === state.generation
      && token.resourceScope === state.resourceScope
    ),
  };
});

vi.mock('../utils/permissions', () => ({ can: () => true }));
vi.mock('../config/featureFlags', () => ({
  featureFlags: { sheetMaterialsReads: true },
}));
vi.mock('../api/cutApi', () => ({
  cutApi: { listSheetTypes: harness.listSheetTypes },
}));
vi.mock('../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => harness.state.active,
  useOrderAsyncReadGuard: (resourceScope: string) => {
    harness.state.resourceScope = resourceScope;
    return {
      active: harness.state.active,
      authNamespace: harness.state.authNamespace,
      capture: harness.capture,
      isCurrent: harness.isCurrent,
    };
  },
}));

import type { CutSheetTypeOption } from '../api/types/cutApi.types';
import { useCutSheetTypeOptions, type UseCutSheetTypeOptionsResult } from './useCutSheetTypeOptions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useCutSheetTypeOptions lifecycle ownership', () => {
  let current: UseCutSheetTypeOptionsResult | null = null;
  let renderer!: ReactTestRenderer;

  const Probe = () => {
    current = useCutSheetTypeOptions();
    return null;
  };

  beforeEach(() => {
    current = null;
    harness.state.active = true;
    harness.state.authNamespace = 'actor:a';
    harness.state.generation = 1;
    harness.listSheetTypes.mockReset();
  });

  it('never publishes actor A sheet types after the same page switches to actor B', async () => {
    const actorA = deferred<CutSheetTypeOption[]>();
    const actorB = deferred<CutSheetTypeOption[]>();
    harness.listSheetTypes
      .mockReturnValueOnce(actorA.promise)
      .mockReturnValueOnce(actorB.promise);

    await act(async () => {
      renderer = create(<Probe />);
    });

    harness.state.authNamespace = 'actor:b';
    harness.state.generation += 1;
    await act(async () => {
      renderer.update(<Probe />);
    });

    await act(async () => {
      actorA.resolve([{
        sheetMaterialTypeId: 1,
        name: 'Actor A sheet',
        thicknessMm: 16,
        widthMm: 1000,
        heightMm: 2000,
        isCuttable: true,
        materialTypeId: 11,
      }]);
      await actorA.promise;
    });
    expect(current?.rawOptions).toEqual([]);

    await act(async () => {
      actorB.resolve([{
        sheetMaterialTypeId: 2,
        name: 'Actor B sheet',
        thicknessMm: 18,
        widthMm: 1200,
        heightMm: 2400,
        isCuttable: true,
        materialTypeId: 12,
      }]);
      await actorB.promise;
    });
    expect(current?.rawOptions.map((option) => option.name)).toEqual(['Actor B sheet']);

    act(() => renderer.unmount());
  });
});
