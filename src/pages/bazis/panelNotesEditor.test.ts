import { describe, expect, it, vi } from 'vitest';
import {
  makeNotesEditorHandlers,
  normalizeNotesInput,
  shouldApplyNotesResponse,
  shouldSaveOnBlur,
  type NotesCloseReason,
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

describe('makeNotesEditorHandlers (исполняемые порядки Enter/blur/Escape)', () => {
  function harness(initial: { busy?: boolean } = {}) {
    let reason: NotesCloseReason = 'none';
    let busy = initial.busy ?? false;
    const save = vi.fn();
    const cancel = vi.fn();
    const handlers = makeNotesEditorHandlers({
      getCloseReason: () => reason,
      setCloseReason: (next) => {
        reason = next;
      },
      isBusy: () => busy,
      save,
      cancel,
    });
    return {
      handlers,
      save,
      cancel,
      setBusy: (value: boolean) => {
        busy = value;
      },
      setReason: (value: NotesCloseReason) => {
        reason = value;
      },
      getReason: () => reason,
    };
  }

  it('Enter commits once; the following blur does not double-save', () => {
    const { handlers, save, cancel } = harness();

    handlers.onPressEnter();
    handlers.onBlur();

    expect(save).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Escape cancels; the following blur does NOT save the cancelled value', () => {
    const { handlers, save, cancel } = harness();

    handlers.onEscape();
    handlers.onBlur();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('plain blur commits once', () => {
    const { handlers, save } = harness();

    handlers.onBlur();
    handlers.onBlur();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('blur while a request is in flight does not save', () => {
    const { handlers, save } = harness({ busy: true });

    handlers.onBlur();

    expect(save).not.toHaveBeenCalled();
  });

  it('Escape while busy neither cancels nor changes the close reason', () => {
    const { handlers, cancel, getReason } = harness({ busy: true });

    handlers.onEscape();

    expect(cancel).not.toHaveBeenCalled();
    expect(getReason()).toBe('none');
  });

  it('after an error the component resets reason to none — blur can retry-save', () => {
    const { handlers, save, setReason } = harness();

    handlers.onPressEnter();
    expect(save).toHaveBeenCalledTimes(1);

    // Компонент в catch сбрасывает closeReason → 'none' (busy → false) —
    // после этого blur снова может сохранить введённое значение.
    setReason('none');
    handlers.onBlur();
    expect(save).toHaveBeenCalledTimes(2);
  });
});
