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
    expect(config).toContain('normalizeMdfBoardHiddenCardRules');
    expect(config).toContain('MDF_BOARD_HIDDEN_CARD_KINDS');
    expect(config).toContain('title="МДФ-доска"');
    expect(config).toContain('SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES');
    expect(config).toContain('productionStatusIds: nextProductionStatusIds');
    expect(config).toContain('orderStatusIds: nextOrderStatusIds');
    expect(config).toContain('cardRules: nextCardRules');
    expect(config).toContain('Файлы станка');
    expect(config).toContain('Базис-раскрой');
    expect(config).toContain('Карты ванн');
    expect(config).toContain('Переносить, когда все заказы в статусах');
    expect(config).toContain('Статусы ниже скрывают карточки заказов с МДФ-доски');
    expect(config).toContain('убирается из активных колонок');
    expect(config).toContain('сами по себе карточку не скрывают');
    expect(config).toContain('aria-label="Производственные статусы, скрывающие карточки с МДФ-доски"');
    expect(config).toContain('aria-label="Статусы заказа, скрывающие карточки с МДФ-доски"');
    expect(config).toContain('Обычные статусы заказа, скрывающие карточки');
    expect(config).toContain('Производственные статусы, скрывающие карточки');
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

  it('uses intent-oriented labels for order-status rule conditions', () => {
    expect(config).toContain('label="Выполнять только при статусах заказа"');
    expect(config).toContain('label="Не выполнять при статусах заказа"');
    expect(config).not.toContain('label="Текущие статусы заказа"');
    expect(config).not.toContain('label="Исключающие статусы заказа"');
  });

  it('offers JSON export and import for auto-status rules with a detailed import report', () => {
    expect(config).toContain('DownloadOutlined');
    expect(config).toContain('UploadOutlined');
    expect(config).toContain('buildStatusAutomationRulesExportFile(rules)');
    expect(config).toContain('readStatusAutomationRulesImportSource(parsedJson)');
    expect(config).toContain('planStatusAutomationRulesImport(rawRules');
    expect(config).toContain('statusAutomationApi.create(item.rule)');
    expect(config).toContain('Выгрузить JSON');
    expect(config).toContain('Загрузить JSON');
    expect(config).toContain('Результат загрузки правил');
    expect(config).toContain('Не удалось загрузить из-за отсутствия или несоответствия элементов');
    expect(config).toContain('Пропущенные дубликаты');
  });

  it('offers a manage-only force refresh for recent orders', () => {
    expect(config).toContain('refreshingRecentOrders');
    expect(config).toContain('statusAutomationApi.refreshRecentOrders()');
    expect(config).toContain('Будут проверены все заказы за последние два месяца');
    expect(config).toContain('действий ${result.totals.executedActionCount}');
    expect(config).toContain('Ошибок: ${result.failedOrderCount}');
    expect(config).toContain('<Button');
    expect(config).toContain('Обновить');
  });
});
