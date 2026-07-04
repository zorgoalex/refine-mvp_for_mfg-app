export const SCAN_FIELD_WEIGHTS: Record<string, number> = {
  detail_id: 10,
  order_id: 8,
  // snapshot > order_name: скан переименованного заказа должен ранжировать
  // снапшот печати выше живого заказа, носящего старое имя (Codex R2).
  snapshot: 7,
  order_name: 5,
  // snapshot_pair: OCR-поток (T4) ретегирует 'snapshot'→'snapshot_pair' для
  // кандидатов, найденных по bazisFields-паре (order_number+position_in_product).
  // СТРОГО < order_name (Codex R2/R3): одинокий stale-снапшот (4+3=7) всё ещё
  // побеждает без живого совпадения, но живой заказ с совпавшим именем
  // (5+3=8) ВСЕГДА выигрывает у чужого снапшота — авто-открытие не той
  // детали исключено. v1 QR-поток не меняется — там тег остаётся 'snapshot'=7.
  snapshot_pair: 4,
  detail_number: 3,
  size: 2,
  material: 1,
};

export function scoreCandidate(matchedFields: string[]): number {
  return matchedFields.reduce((sum, tag) => sum + (SCAN_FIELD_WEIGHTS[tag] ?? 0), 0);
}

export function rankCandidates<T extends { score: number; detailId: number }>(
  candidates: T[],
  opts?: { limit?: number; minScore?: number },
): T[] {
  const limit = opts?.limit ?? 10;
  const minScore = opts?.minScore ?? 3;
  return [...candidates]
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.detailId - b.detailId) // детерминизм при равном score
    .slice(0, limit);
}
