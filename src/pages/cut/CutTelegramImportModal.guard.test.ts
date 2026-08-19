import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CutTelegramImportModal.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../hooks/useCncTelegramImport.ts', import.meta.url), 'utf8');

describe('manual Telegram import UI safety guards', () => {
  it('keeps candidate selection opt-in and duplicate rows selectable', () => {
    expect(source).toContain('const [selectedIds, setSelectedIds] = useState<string[]>([]);');
    expect(source).toContain("getCheckboxProps: (record) => ({ disabled: record.eligibility !== 'eligible' || record.sourceStatus === 'expired' })");
    expect(source).toContain("message.warning('Выберите хотя бы один комплект')");
    expect(source).toContain("'Создать всё равно'");
  });

  it('uses bounded date period and explicit confirmation before create', () => {
    expect(source).toContain('const MAX_SCAN_DAYS = 31;');
    expect(source).toContain('duplicateAcknowledged: candidateDuplicate(candidate)');
    expect(source).toContain('Будут созданы новые задания');
  });

  it('persists active scan/request and invalidates operational reads after terminal import', () => {
    expect(hook).toContain('ACTIVE_SCAN_STORAGE_KEY');
    expect(hook).toContain('ACTIVE_REQUEST_STORAGE_KEY');
    expect(hook).toContain("resource: 'cut-jobs'");
    expect(hook).toContain("resource: 'orders_status_board'");
    expect(hook).toContain("resource: 'cnc-telegram'");
  });

  it('defaults every modal open and every scan to the original message view', () => {
    expect(source).toContain("useState<MessageViewMode>('original')");
    expect(source).toContain("setMessageView('original');");
    expect(source).toContain("items={[{ key: 'original', label: 'Оригинальный' }, { key: 'technical', label: 'Технический' }]}");
  });

  it('keeps technical identifiers out of the original Telegram feed', () => {
    const originalStart = source.indexOf('const OriginalMessageFeed');
    const technicalStart = source.indexOf('const TechnicalMessageCards');
    const original = source.slice(originalStart, technicalStart);
    expect(originalStart).toBeGreaterThanOrEqual(0);
    expect(technicalStart).toBeGreaterThan(originalStart);
    expect(original).toContain('importMessageHumanContent(entry)');
    expect(original).toContain('importMessageTimeLabel(entry.sourceCreatedAt)');
    expect(original).not.toContain('MessageSelection');
    expect(original).not.toContain('sourceMessageId');
    expect(original).not.toContain('senderUserId');
  });
});
