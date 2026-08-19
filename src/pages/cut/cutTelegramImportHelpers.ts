import type {
  CncTelegramImportCandidate,
  CncTelegramImportItem,
  CncTelegramImportMessage,
  CncTelegramImportRequest,
} from '../../api/types/cncTelegramImportApi.types';

export interface CandidateLayoutSummary {
  sheetWidthMm: number | null;
  sheetHeightMm: number | null;
  sheetCount: number | null;
  positionCount: number | null;
  orderLabels: string[];
}

export function hasCandidateScreenshot(candidate: Pick<CncTelegramImportCandidate, 'screenshotFileName' | 'screenshotMessageId' | 'screenshotContentSha256'>): boolean {
  return candidate.screenshotMessageId != null
    || Boolean(candidate.screenshotContentSha256?.trim())
    || Boolean(candidate.screenshotFileName?.trim());
}

export function candidateScreenshotLabel(candidate: Pick<CncTelegramImportCandidate, 'screenshotFileName' | 'screenshotMessageId' | 'screenshotContentSha256'>): string {
  if (!hasCandidateScreenshot(candidate)) return 'нет';
  const fileName = candidate.screenshotFileName?.trim();
  if (fileName) return `найден · ${fileName}`;
  if (candidate.screenshotMessageId != null) return `найден · сообщение #${candidate.screenshotMessageId}`;
  return 'найден · файл сохранён';
}

export function candidateLayoutSummary(candidate: Pick<CncTelegramImportCandidate, 'sheetWidthMm' | 'sheetHeightMm' | 'sheetCount' | 'positionCount' | 'orderLabels' | 'cutLayout'>): CandidateLayoutSummary {
  const layout = candidate.cutLayout;
  const layoutItems = layout?.items ?? [];
  const layoutOrders = Array.from(new Set(layoutItems.map((item) => item.orderName.trim()).filter(Boolean)));
  return {
    sheetWidthMm: candidate.sheetWidthMm ?? layout?.sheet?.widthMm ?? null,
    sheetHeightMm: candidate.sheetHeightMm ?? layout?.sheet?.heightMm ?? null,
    sheetCount: candidate.sheetCount ?? (layout?.sheet ? 1 : null),
    positionCount: candidate.positionCount ?? (layout ? layoutItems.length : null),
    orderLabels: candidate.orderLabels?.length ? candidate.orderLabels : layoutOrders,
  };
}

export function sortImportMessages(messages: CncTelegramImportMessage[]): CncTelegramImportMessage[] {
  return [...messages].sort((left, right) => new Date(left.sourceCreatedAt).getTime() - new Date(right.sourceCreatedAt).getTime()
    || left.readOrdinal - right.readOrdinal
    || left.scanMessageId.localeCompare(right.scanMessageId));
}

export function importMessageAttachmentLabel(message: Pick<CncTelegramImportMessage, 'messageType' | 'filename' | 'candidateRole'>): string {
  const fileName = message.filename?.trim();
  const label = message.candidateRole === 'screenshot'
    ? 'Скриншот'
    : message.messageType === 'image'
      ? 'Фото'
      : message.messageType === 'svg'
        ? 'SVG'
        : message.messageType === 'gcode'
          ? 'G-code'
          : message.messageType === 'dxf'
            ? 'DXF'
            : 'Вложение';
  return `${label} · ${fileName || 'имя файла не указано'}`;
}

export function importMessageHumanContent(message: Pick<CncTelegramImportMessage, 'messageType' | 'filename' | 'candidateRole' | 'messageText'>): string {
  const text = message.messageText?.trim();
  return text || (message.messageType === 'text' ? 'Сообщение без текста' : importMessageAttachmentLabel(message));
}

export function importMessageTimeLabel(sourceCreatedAt: string): string {
  return new Date(sourceCreatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function eligibleCandidateIdForMessage(
  message: Pick<CncTelegramImportMessage, 'candidateId'>,
  candidates: Pick<CncTelegramImportCandidate, 'candidateId' | 'eligibility' | 'sourceStatus'>[],
): string | null {
  if (!message.candidateId) return null;
  const candidate = candidates.find((entry) => entry.candidateId === message.candidateId);
  return candidate?.eligibility === 'eligible' && candidate.sourceStatus !== 'expired'
    ? candidate.candidateId
    : null;
}

export function repeatableItems(request: CncTelegramImportRequest): CncTelegramImportItem[] {
  if (request.status === 'completed') return request.items;
  return request.items.filter((item) => ['failed', 'unknown', 'confirmation_required'].includes(item.status));
}

export function needsDuplicateReconfirmation(request: CncTelegramImportRequest): boolean {
  return request.status === 'draft'
    || request.items.some((item) => item.status === 'confirmation_required');
}
