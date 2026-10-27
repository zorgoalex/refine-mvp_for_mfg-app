import React, { useRef, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('../../api/authSession', () => ({ authSession: {
  getSessionGeneration: () => auth.generation,
  subscribe: (listener: () => void) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); },
} }));

import { useSessionGenerationReset } from './useSessionGenerationReset';

const changeSession = () => { auth.generation += 1; auth.listeners.forEach((listener) => listener()); };

type Read = { resolve: (cards: string[]) => void; reject: () => void };
let shown: string[] | null = null;
let reload: () => void = () => undefined;
const reads: Read[] = [];

/** The board's load contract: a read applies its result only if no session change happened since it started. */
function Board(props: { active: boolean }) {
  const revisionRef = useRef(0);
  const [cards, setCards] = useState<string[] | null>(['old-scope-card']);
  shown = cards;
  const load = () => {
    const revision = revisionRef.current;
    new Promise<string[]>((resolve, reject) => reads.push({ resolve, reject: () => reject(new Error('read failed')) }))
      .then((next) => { if (revisionRef.current === revision) setCards(next); })
      .catch(() => undefined);
  };
  reload = load;
  useSessionGenerationReset({ active: props.active, revisionRef, onReset: (isShown) => {
    setCards(null);
    if (isShown) load();
  } });
  return null;
}

describe('useSessionGenerationReset', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => { act(() => renderer?.unmount()); reads.length = 0; auth.listeners.clear(); });

  it('drops the shown data at once; a late read of the old session and a failed new read never bring it back', async () => {
    await act(async () => { renderer = create(<Board active />); });
    reload(); // a background refresh started under the old session
    const oldRead = reads[0];
    await act(async () => { changeSession(); });
    expect(shown).toBeNull();
    expect(reads).toHaveLength(2); // shown board reads again under the new session
    await act(async () => { oldRead.resolve(['old-scope-card']); });
    expect(shown).toBeNull();
    await act(async () => { reads[1].reject(); });
    expect(shown).toBeNull();
  });

  it('drops the data of a hidden board without reading; the new session read applies', async () => {
    await act(async () => { renderer = create(<Board active={false} />); });
    reload();
    const oldRead = reads[0];
    await act(async () => { changeSession(); });
    expect(shown).toBeNull();
    expect(reads).toHaveLength(1); // hidden: no read until shown again
    await act(async () => { oldRead.resolve(['old-scope-card']); });
    expect(shown).toBeNull();
    await act(async () => { renderer.update(<Board active />); });
    reload();
    await act(async () => { reads[1].resolve(['new-scope-card']); });
    expect(shown).toEqual(['new-scope-card']);
  });
});
