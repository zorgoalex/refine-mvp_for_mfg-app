import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(
  'src/pages/configuration/components/StatusAutomationConfig.tsx',
  'utf8',
);
const settings = readFileSync('src/hooks/useAppSettings.ts', 'utf8');

describe('StatusAutomationConfig CNC cut-status setting guards', () => {
  it('stores a dedicated disabled-by-default app setting for completed machine files', () => {
    expect(settings).toContain(
      "STATUS_AUTOMATION_CNC_MARK_CUT_DETAILS: 'status_automation.cnc_mark_cut_details'",
    );
    expect(config).toContain('SETTING_KEYS.STATUS_AUTOMATION_CNC_MARK_CUT_DETAILS');
    expect(config).toContain('getSetting<boolean>');
    expect(config).toContain('cncTelegramApi.configureAutoCutStatus(enabled)');
    expect(config).toContain('setConfirmedAutoCutStatusEnabled(result.settingEnabled)');
    expect(config).toContain('await refetchAppSettings().catch(() => undefined)');
    expect(config).toContain('storedAutoCutStatusEnabled === confirmedAutoCutStatusEnabled');
  });

  it('stores explicit MDF board order and production statuses in the Auto statuses tab', () => {
    expect(settings).toContain(
      "STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES:",
    );
    expect(settings).toContain(
      "'status_automation.mdf_board_hidden_production_statuses'",
    );
    expect(config).toContain('DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES');
    expect(config).toContain('MdfBoardHiddenStatusesSetting');
    expect(config).toContain('title="МДФ-доска"');
    expect(config).toContain('SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES');
    expect(config).toContain('productionStatusIds: nextProductionStatusIds');
    expect(config).toContain('orderStatusIds: nextOrderStatusIds');
    expect(config).toContain('aria-label="Производственные статусы, скрывающие карточки с МДФ-доски"');
    expect(config).toContain('aria-label="Статусы заказа, скрывающие карточки с МДФ-доски"');
    expect(config).toContain('Обычные статусы заказа');
  });

  it('shows a permission-aware toggle in the Auto statuses tab', () => {
    expect(config).toContain('title="Автостатус распила"');
    expect(config).toContain('При переходе карточки в «Распилено»');
    expect(config).toContain('Комментарий «весь заказ»');
    expect(config).toContain('карточки обрабатываются сразу');
    expect(config).toContain('disabled={!canManage');
    expect(config).toContain(
      'aria-label="Автоматически отмечать распиленными детали завершённых файлов станка"',
    );
  });

  it('does not allow enabling automation without an active «Распилен» status', () => {
    expect(config).toContain("=== 'распилен'");
    expect(config).toContain("=== 'cut'");
    expect(config).toContain('Производственный статус «Распилен» не найден');
  });
});
