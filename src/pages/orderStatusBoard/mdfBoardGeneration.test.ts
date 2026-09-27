import { describe, expect, it } from 'vitest';
import {
  bumpMdfBoardGeneration,
  createMdfBoardGenerationState,
  isMdfBoardGenerationCurrent,
} from './mdfBoardGeneration';

describe('mdf board generation guard', () => {
  it('focus A requested, switch to B, B completes, A completes last: board stays on B', () => {
    let state = createMdfBoardGenerationState();
    const a = bumpMdfBoardGeneration(state); // focus A
    state = a.state;
    const b = bumpMdfBoardGeneration(state); // switch to B before A resolves
    state = b.state;

    // B completes first.
    expect(isMdfBoardGenerationCurrent(state, b.requestGeneration)).toBe(true);
    // Apply B's response here (simulated by the caller).

    // A completes last — must be dropped even though it "arrived" after B was applied.
    expect(isMdfBoardGenerationCurrent(state, a.requestGeneration)).toBe(false);
  });

  it('ignores an error from a superseded request', () => {
    let state = createMdfBoardGenerationState();
    const first = bumpMdfBoardGeneration(state);
    state = first.state;
    const second = bumpMdfBoardGeneration(state);
    state = second.state;
    // first's request eventually rejects; caller checks before setting an error state.
    expect(isMdfBoardGenerationCurrent(state, first.requestGeneration)).toBe(false);
  });

  it('ignores a 304 from a superseded request', () => {
    let state = createMdfBoardGenerationState();
    const first = bumpMdfBoardGeneration(state);
    state = first.state;
    const second = bumpMdfBoardGeneration(state);
    state = second.state;
    // first's request completes with 304 (etag match) after second was issued.
    expect(isMdfBoardGenerationCurrent(state, first.requestGeneration)).toBe(false);
    expect(isMdfBoardGenerationCurrent(state, second.requestGeneration)).toBe(true);
  });

  it('two tabs converge: each tracks its own generation independently, both accept their latest', () => {
    let tabA = createMdfBoardGenerationState();
    let tabB = createMdfBoardGenerationState();
    const reqA = bumpMdfBoardGeneration(tabA);
    tabA = reqA.state;
    const reqB = bumpMdfBoardGeneration(tabB);
    tabB = reqB.state;
    expect(isMdfBoardGenerationCurrent(tabA, reqA.requestGeneration)).toBe(true);
    expect(isMdfBoardGenerationCurrent(tabB, reqB.requestGeneration)).toBe(true);
  });

  it('a fresh refresh at the same query also bumps the generation and supersedes the prior request', () => {
    let state = createMdfBoardGenerationState();
    const first = bumpMdfBoardGeneration(state);
    state = first.state;
    const refresh = bumpMdfBoardGeneration(state); // 15s poll / visibility refresh
    state = refresh.state;
    expect(isMdfBoardGenerationCurrent(state, first.requestGeneration)).toBe(false);
    expect(isMdfBoardGenerationCurrent(state, refresh.requestGeneration)).toBe(true);
  });
});
