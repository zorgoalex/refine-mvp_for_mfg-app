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
});
