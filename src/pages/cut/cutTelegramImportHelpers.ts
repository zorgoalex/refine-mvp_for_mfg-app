import type { CncTelegramImportItem, CncTelegramImportRequest } from '../../api/types/cncTelegramImportApi.types';

export function repeatableItems(request: CncTelegramImportRequest): CncTelegramImportItem[] {
  if (request.status === 'completed') return request.items;
  return request.items.filter((item) => ['failed', 'unknown', 'confirmation_required'].includes(item.status));
}

export function needsDuplicateReconfirmation(request: CncTelegramImportRequest): boolean {
  return request.status === 'draft'
    || request.items.some((item) => item.status === 'confirmation_required');
}

