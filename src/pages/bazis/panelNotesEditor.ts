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
