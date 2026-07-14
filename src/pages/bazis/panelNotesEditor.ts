// Pure-хелперы инлайн-редактора примечаний панели (без React — unit-тесты
// в node-env). Модель: одна сессия редактирования = один терминальный исход.
// Enter → commit; Escape → cancel (последующий blur НЕ сохраняет);
// blur без Enter/Escape → commit.

export const NODE_NOTES_MAX_LENGTH = 2000;

export type NotesCloseReason = 'none' | 'commit' | 'cancel';

/** '' и whitespace → null; иначе trimmed-текст. */
export function normalizeNotesInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** blur сохраняет ТОЛЬКО когда сессию ещё не закрыли Enter/Escape и нет запроса в полёте. */
export function shouldSaveOnBlur(reason: NotesCloseReason, busy: boolean): boolean {
  return reason === 'none' && !busy;
}

/** Поздний PATCH-ответ применяется только в своей эпохе (смена ревизии/узлов = новая эпоха). */
export function shouldApplyNotesResponse(originEpoch: number, currentEpoch: number): boolean {
  return originEpoch === currentEpoch;
}

export interface NotesEditorHooks {
  getCloseReason(): NotesCloseReason;
  setCloseReason(reason: NotesCloseReason): void;
  isBusy(): boolean;
  /** Запустить сохранение (сам save busy-гардится внутри компонента). */
  save(): void;
  /** Закрыть редактор без сохранения. */
  cancel(): void;
}

export interface NotesEditorHandlers {
  onPressEnter(): void;
  onBlur(): void;
  onEscape(): void;
}

/**
 * Вся событийная логика редактора — pure-фабрика (исполняемые unit-тесты
 * порядков Enter/blur/Escape вместо source-text guard'ов, code-Critic R1).
 * Инвариант one-shot: Enter → commit; Escape → cancel, последующий blur НЕ
 * сохраняет; blur без Enter/Escape → commit; busy глушит blur-save и Escape.
 */
export function makeNotesEditorHandlers(hooks: NotesEditorHooks): NotesEditorHandlers {
  return {
    onPressEnter() {
      hooks.setCloseReason('commit');
      hooks.save();
    },
    onBlur() {
      if (shouldSaveOnBlur(hooks.getCloseReason(), hooks.isBusy())) {
        hooks.setCloseReason('commit');
        hooks.save();
      }
    },
    onEscape() {
      if (hooks.isBusy()) {
        return;
      }
      hooks.setCloseReason('cancel');
      hooks.cancel();
    },
  };
}
