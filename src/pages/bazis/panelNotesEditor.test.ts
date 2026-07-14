import { describe, expect, it } from 'vitest';
import {
  normalizeNotesInput,
  shouldApplyNotesResponse,
  shouldSaveOnBlur,
} from './panelNotesEditor';

describe('normalizeNotesInput', () => {
  it('trims and coerces empty/whitespace to null', () => {
    expect(normalizeNotesInput('  текст  ')).toBe('текст');
    expect(normalizeNotesInput('')).toBeNull();
    expect(normalizeNotesInput('   ')).toBeNull();
  });
});

describe('shouldSaveOnBlur', () => {
  it('saves on plain blur', () => {
    expect(shouldSaveOnBlur('none', false)).toBe(true);
  });
  it('does NOT save after Escape (cancel wins over blur)', () => {
    expect(shouldSaveOnBlur('cancel', false)).toBe(false);
  });
  it('does NOT double-save after Enter commit', () => {
    expect(shouldSaveOnBlur('commit', false)).toBe(false);
    expect(shouldSaveOnBlur('commit', true)).toBe(false);
  });
  it('does NOT save while a request is in flight', () => {
    expect(shouldSaveOnBlur('none', true)).toBe(false);
  });
});

describe('shouldApplyNotesResponse', () => {
  it('applies only within the same epoch (revision switch = new epoch)', () => {
    expect(shouldApplyNotesResponse(1, 1)).toBe(true);
    expect(shouldApplyNotesResponse(1, 2)).toBe(false);
  });
});
