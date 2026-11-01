// «Импорт» в шапке списка заказов (NewLine, мокап 03): «Создать заказ из файла». Список запоминает, какой импорт
// открыть, и открывает форму нового заказа; кнопка «Импорт» этой формы забирает запрос один раз и сразу открывает
// нужное окно (Excel, PDF Базиса, фото). Запрос живёт недолго: если форма не открылась, он не сработает потом
// в чужой форме.

export type PendingOrderImportKind = 'excel' | 'pdf' | 'vlm';

const PENDING_IMPORT_TTL_MS = 15_000;

let pending: { kind: PendingOrderImportKind; at: number } | null = null;

export function requestOrderImport(kind: PendingOrderImportKind, now: number = Date.now()): void {
  pending = { kind, at: now };
}

/** Забрать запрос (один раз); просроченный — отбрасывается. */
export function takePendingOrderImport(now: number = Date.now()): PendingOrderImportKind | null {
  const request = pending;
  pending = null;
  if (!request || now - request.at > PENDING_IMPORT_TTL_MS) return null;
  return request.kind;
}
