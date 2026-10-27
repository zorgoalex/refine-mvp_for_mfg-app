import { describe, expect, it, vi } from 'vitest';
import { keepsShownMdfBoard, mdfShownDataKey, resetMdfBoardForNewSession, type MdfBoardSessionData } from './mdfBoardSessionData';

function data(): MdfBoardSessionData & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => vi.fn((...args: unknown[]) => { calls.push(args.length ? `${name}:${String(args[0])}` : name); });
  return { calls, dropInitialSnapshot: record('dropInitialSnapshot'), dropAuxiliaryReads: record('dropAuxiliaryReads'), clearBoard: record('clearBoard'),
    clearToday: record('clearToday'), clearOrderSearchToday: record('clearOrderSearchToday'),
    clearOriginalBoard: record('clearOriginalBoard'), clearOrderBoard: record('clearOrderBoard'),
    setShownKey: record('setShownKey'), reload: record('reload') };
}

const ALL_CLEARED = ['dropInitialSnapshot', 'dropAuxiliaryReads', 'clearBoard', 'clearToday', 'clearOrderSearchToday', 'clearOriginalBoard',
  'clearOrderBoard'];

describe('MDF board data across auth sessions', () => {
  it('a shown board drops every part, then reads again under the new session and keeps that as its shown key', () => {
    const board = data();
    resetMdfBoardForNewSession(board, { shown: true, datasetKey: 'ds', sessionGeneration: 2 });
    expect(board.calls).toEqual([...ALL_CLEARED, 'setShownKey:ds|2', 'reload']);
  });

  it('a hidden board drops every part without reading and loads in full when shown again', () => {
    const board = data();
    resetMdfBoardForNewSession(board, { shown: false, datasetKey: 'ds', sessionGeneration: 2 });
    expect(board.calls).toEqual([...ALL_CLEARED, 'setShownKey:null']);
    expect(keepsShownMdfBoard(null, mdfShownDataKey('ds', 2), true)).toBe(false);
  });

  it('keeps the shown board on return only for the same dataset, session and existing data', () => {
    const shown = mdfShownDataKey('ds', 1);
    expect(keepsShownMdfBoard(shown, mdfShownDataKey('ds', 1), true)).toBe(true);
    expect(keepsShownMdfBoard(shown, mdfShownDataKey('ds', 2), true)).toBe(false); // re-login / new scope
    expect(keepsShownMdfBoard(shown, mdfShownDataKey('other', 1), true)).toBe(false); // another day/period
    expect(keepsShownMdfBoard(shown, mdfShownDataKey('ds', 1), false)).toBe(false); // nothing loaded (failed read)
  });
});
