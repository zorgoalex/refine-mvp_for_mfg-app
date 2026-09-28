import { describe, expect, it } from 'vitest';
import {
  onecCertExpirySeverity,
  onecCommandCancellable,
  onecCommandPayloadFromForm,
  onecCommandSourceLabel,
  onecCommandStatusColor,
  onecCommandStatusLabel,
  onecCommandTypeDescription,
  onecCommandTypeLabel,
  onecConnectionBadge,
  onecDefaultProbeMarker,
  onecDiffConfigurations,
  onecEtlEntityFromFormValues,
  onecEtlEntityToFormValues,
  onecIdentityWarning,
  onecIfMatchHeader,
  onecModeLabel,
  onecRelativeTime,
  onecStableStringify,
  onecStateBadge,
  ONEC_ETL_ENTITY_FORM_DEFAULTS,
  type OnecEtlEntityFormValues,
  onecAlertResolvable,
} from './onecFormat';
import type { OnecAgentConfiguration, OnecEtlEntity } from './onecApi.types';

describe('onecModeLabel', () => {
  it('translates known modes to Russian and falls back to the raw value', () => {
    expect(onecModeLabel('Normal')).toBe('Работа');
    expect(onecModeLabel('Disabled')).toBe('Отключён');
    expect(onecModeLabel('Unknown')).toBe('Unknown');
  });
});

describe('onecCommandTypeLabel', () => {
  it('translates known command types', () => {
    expect(onecCommandTypeLabel('create_customer_order')).toBe('Создать заказ покупателя');
    expect(onecCommandTypeLabel('mystery_command')).toBe('mystery_command');
  });
});

describe('onecConnectionBadge', () => {
  it('maps connection state to a badge status/text', () => {
    expect(onecConnectionBadge('online')).toEqual({ status: 'success', text: 'В сети' });
    expect(onecConnectionBadge('silent')).toEqual({ status: 'warning', text: 'Молчит' });
    expect(onecConnectionBadge('never_seen')).toEqual({ status: 'default', text: 'Не подключался' });
  });
});

describe('onecStateBadge', () => {
  it('maps heartbeat state to a badge, defaulting when null', () => {
    expect(onecStateBadge(null)).toEqual({ status: 'default', text: 'Нет данных' });
    expect(onecStateBadge('healthy')).toEqual({ status: 'success', text: 'Норма' });
    expect(onecStateBadge('degraded')).toEqual({ status: 'warning', text: 'Деградация' });
    expect(onecStateBadge('offline_onec').status).toBe('error');
    expect(onecStateBadge('storage_critical').status).toBe('error');
    expect(onecStateBadge('incompatible_version').status).toBe('error');
    expect(onecStateBadge('maintenance')).toEqual({ status: 'processing', text: 'Обслуживание' });
  });
});

describe('onecIdentityWarning', () => {
  it('warns only for identity_changed', () => {
    expect(onecIdentityWarning('identity_changed')).toMatch(/сменилась/i);
    expect(onecIdentityWarning('bound')).toBeNull();
    expect(onecIdentityWarning('unverified')).toBeNull();
  });
});

describe('onecCertExpirySeverity', () => {
  const now = new Date('2026-01-01T00:00:00Z').getTime();

  it('has no severity when there is no certificate date', () => {
    expect(onecCertExpirySeverity(null, now)).toBe('none');
    expect(onecCertExpirySeverity(undefined, now)).toBe('none');
  });

  it('is critical at or under 7 days, including already expired', () => {
    expect(onecCertExpirySeverity(new Date(now - 86_400_000).toISOString(), now)).toBe('critical');
    expect(onecCertExpirySeverity(new Date(now + 7 * 86_400_000).toISOString(), now)).toBe('critical');
  });

  it('is warning between 8 and 30 days', () => {
    expect(onecCertExpirySeverity(new Date(now + 30 * 86_400_000).toISOString(), now)).toBe('warning');
    expect(onecCertExpirySeverity(new Date(now + 8 * 86_400_000).toISOString(), now)).toBe('warning');
  });

  it('is ok beyond 30 days', () => {
    expect(onecCertExpirySeverity(new Date(now + 31 * 86_400_000).toISOString(), now)).toBe('ok');
  });
});

describe('onecRelativeTime', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime();

  it('formats null as "никогда"', () => {
    expect(onecRelativeTime(null, now)).toBe('никогда');
  });

  it('formats recent timestamps in minutes/hours/days', () => {
    expect(onecRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe('только что');
    expect(onecRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 мин назад');
    expect(onecRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 ч назад');
    expect(onecRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 дн назад');
  });
});

describe('onecIfMatchHeader', () => {
  it('omits the header when there is no draft yet', () => {
    expect(onecIfMatchHeader(null)).toBeUndefined();
    expect(onecIfMatchHeader(undefined)).toBeUndefined();
  });

  it('sends the draft revision as a plain string', () => {
    expect(onecIfMatchHeader(5)).toEqual({ 'If-Match': '5' });
    expect(onecIfMatchHeader(0)).toEqual({ 'If-Match': '0' });
  });
});

describe('onecStableStringify', () => {
  it('is independent of key order, unlike JSON.stringify', () => {
    const a = { mode: 'Normal', etlIntervalMinutes: 60 };
    const b = { etlIntervalMinutes: 60, mode: 'Normal' };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(onecStableStringify(a)).toBe(onecStableStringify(b));
  });

  it('sorts keys recursively inside arrays and nested objects', () => {
    const a = { entities: [{ b: 2, a: 1 }] };
    const b = { entities: [{ a: 1, b: 2 }] };
    expect(onecStableStringify(a)).toBe(onecStableStringify(b));
  });

  it('still distinguishes genuinely different values', () => {
    expect(onecStableStringify({ a: 1 })).not.toBe(onecStableStringify({ a: 2 }));
  });
});

const baseConfiguration: OnecAgentConfiguration = {
  mode: 'Normal',
  commandTypes: ['integration_probe'],
  etlIntervalMinutes: 60,
  etlEntities: [],
};

describe('onecDiffConfigurations', () => {
  it('returns nothing when there is no draft', () => {
    expect(onecDiffConfigurations(null, baseConfiguration)).toEqual([]);
  });

  it('flags a first publication when there is no published configuration yet', () => {
    expect(onecDiffConfigurations(baseConfiguration, null)).toEqual(['Первая публикация конфигурации']);
  });

  it('reports no changes for an identical draft', () => {
    expect(onecDiffConfigurations(baseConfiguration, { ...baseConfiguration })).toEqual([]);
  });

  it('reports mode, interval, command type and entity changes', () => {
    const draft: OnecAgentConfiguration = {
      mode: 'PauseEtl',
      commandTypes: ['integration_probe', 'create_customer_order'],
      etlIntervalMinutes: 30,
      etlEntities: [
        {
          entityCode: 'clients',
          oDataPath: 'Catalog_Clients',
          keyFields: ['Ref_Key'],
          select: ['Ref_Key', 'Description'],
          syncMode: 'full',
          pageSize: 500,
          overlapMinutes: 5,
        },
      ],
    };
    const diff = onecDiffConfigurations(draft, baseConfiguration);
    expect(diff).toContain('Режим: Работа → Пауза выгрузки');
    expect(diff).toContain('Интервал выгрузки: 60 мин → 30 мин');
    expect(diff).toContain('Добавлены команды: Создать заказ покупателя');
    expect(diff).toContain('Добавлены сущности выгрузки: clients');
  });

  it('detects a changed entity with the same code', () => {
    const entity: OnecEtlEntity = {
      entityCode: 'clients',
      oDataPath: 'Catalog_Clients',
      keyFields: ['Ref_Key'],
      select: ['Ref_Key'],
      syncMode: 'full',
      pageSize: 500,
      overlapMinutes: 0,
    };
    const published: OnecAgentConfiguration = { ...baseConfiguration, etlEntities: [entity] };
    const draft: OnecAgentConfiguration = {
      ...baseConfiguration,
      etlEntities: [{ ...entity, pageSize: 1000 }],
    };
    expect(onecDiffConfigurations(draft, published)).toEqual(['Изменена сущность выгрузки: clients']);
  });

  it('does not flag an entity as changed just because keys are ordered differently', () => {
    const publishedEntity = {
      entityCode: 'clients',
      oDataPath: 'Catalog_Clients',
      keyFields: ['Ref_Key'],
      select: ['Ref_Key'],
      syncMode: 'full',
      pageSize: 500,
      overlapMinutes: 0,
    } as OnecEtlEntity;
    // Same entity, but constructed with a different key insertion order —
    // simulates a server round-trip through zod (schema-declaration order).
    const draftEntity = {
      overlapMinutes: 0,
      pageSize: 500,
      syncMode: 'full',
      select: ['Ref_Key'],
      keyFields: ['Ref_Key'],
      oDataPath: 'Catalog_Clients',
      entityCode: 'clients',
    } as OnecEtlEntity;
    const published: OnecAgentConfiguration = { ...baseConfiguration, etlEntities: [publishedEntity] };
    const draft: OnecAgentConfiguration = { ...baseConfiguration, etlEntities: [draftEntity] };
    expect(onecDiffConfigurations(draft, published)).toEqual([]);
  });
});

describe('onec ETL entity form conversion', () => {
  it('round-trips a full entity through form values', () => {
    const entity: OnecEtlEntity = {
      entityCode: 'orders',
      oDataPath: 'Document_CustomerOrder',
      keyFields: ['Ref_Key'],
      updatedAtField: 'DataVersion',
      updatedAtEdmType: 'Edm.DateTimeOffset',
      deletedField: 'DeletionMark',
      select: ['Ref_Key', 'Number', 'Date'],
      syncMode: 'full',
      pageSize: 200,
      overlapMinutes: 10,
      schemaVersion: 2,
      oDataVersion: 4,
      enabled: true,
    };
    const formValues = onecEtlEntityToFormValues(entity);
    expect(formValues.keyFieldsText).toBe('Ref_Key');
    expect(formValues.selectText).toBe('Ref_Key, Number, Date');
    expect(onecEtlEntityFromFormValues(formValues)).toEqual(entity);
  });

  it('omits empty optional fields instead of sending empty strings', () => {
    const values: OnecEtlEntityFormValues = {
      ...ONEC_ETL_ENTITY_FORM_DEFAULTS,
      entityCode: 'materials',
      oDataPath: 'Catalog_Materials',
      keyFieldsText: 'Ref_Key',
      selectText: 'Ref_Key, Description',
    };
    const entity = onecEtlEntityFromFormValues(values);
    expect(entity).not.toHaveProperty('updatedAtField');
    expect(entity).not.toHaveProperty('updatedAtEdmType');
    expect(entity).not.toHaveProperty('deletedField');
    expect(entity).not.toHaveProperty('schemaVersion');
    expect(entity).not.toHaveProperty('oDataVersion');
    expect(entity.keyFields).toEqual(['Ref_Key']);
    expect(entity.select).toEqual(['Ref_Key', 'Description']);
    expect(entity.enabled).toBe(true);
  });

  it('splits key/select fields on commas and whitespace', () => {
    const values: OnecEtlEntityFormValues = {
      ...ONEC_ETL_ENTITY_FORM_DEFAULTS,
      entityCode: 'x',
      oDataPath: 'Catalog_X',
      keyFieldsText: 'Ref_Key,  Second_Key',
      selectText: 'Ref_Key Description,Comment',
    };
    const entity = onecEtlEntityFromFormValues(values);
    expect(entity.keyFields).toEqual(['Ref_Key', 'Second_Key']);
    expect(entity.select).toEqual(['Ref_Key', 'Description', 'Comment']);
  });
});

describe('agent-bound configuration writes (R2 review: cross-agent save race)', () => {
  it('allows writes only for the loaded, still-selected agent while idle', async () => {
    const { onecConfigWritable } = await import('./onecFormat');
    expect(onecConfigWritable({ selectedAgentId: 'a', loadedAgentId: 'a', loading: false })).toBe(true);
    // A -> B switch: form still holds A, B is loading or not loaded yet.
    expect(onecConfigWritable({ selectedAgentId: 'b', loadedAgentId: 'a', loading: true })).toBe(false);
    expect(onecConfigWritable({ selectedAgentId: 'b', loadedAgentId: 'a', loading: false })).toBe(false);
    expect(onecConfigWritable({ selectedAgentId: 'b', loadedAgentId: 'b', loading: true })).toBe(false);
    expect(onecConfigWritable({ selectedAgentId: null, loadedAgentId: null, loading: false })).toBe(false);
  });

  it('drops out-of-order and other-agent responses', async () => {
    const { onecIsCurrentResponse } = await import('./onecFormat');
    expect(onecIsCurrentResponse({ requestSeq: 2, latestSeq: 2, requestAgentId: 'b', selectedAgentId: 'b' })).toBe(true);
    // Older request for A resolving after the B request started.
    expect(onecIsCurrentResponse({ requestSeq: 1, latestSeq: 2, requestAgentId: 'a', selectedAgentId: 'b' })).toBe(false);
    // Latest request, but the operator already switched to another agent.
    expect(onecIsCurrentResponse({ requestSeq: 3, latestSeq: 3, requestAgentId: 'a', selectedAgentId: 'b' })).toBe(false);
  });

  it('formats the backend state-history summary object', async () => {
    const { onecFormatHistorySummary } = await import('./onecFormat');
    expect(onecFormatHistorySummary(null)).toBe('—');
    expect(
      onecFormatHistorySummary({ version: '1.2.0', odataAvailable: true, commandApiAvailable: false,
        queues: { commandsPending: 1, resultsPending: 0, etlBatchesPending: 2, deadLetters: 0 }, diskFreeBytes: 2 * 1024 ** 3 }),
    ).toBe('версия 1.2.0; OData: доступен; команды 1С: недоступны; очереди: команды 1, результаты 0, пакеты 2, dead-letter 0; диск свободно 2.0 ГБ');
  });
});

describe('onecCommandTypeLabel / onecCommandTypeDescription (admin commands)', () => {
  it('translates admin command types to Russian and falls back to the raw value', () => {
    expect(onecCommandTypeLabel('start_full_sync')).toBe('Запустить полную выгрузку');
    expect(onecCommandTypeLabel('reload_entity')).toBe('Перезагрузить сущность');
    expect(onecCommandTypeLabel('pause_etl')).toBe('Приостановить выгрузку');
    expect(onecCommandTypeLabel('resume_etl')).toBe('Возобновить выгрузку');
    expect(onecCommandTypeLabel('run_connectivity_test')).toBe('Проверить связь');
    expect(onecCommandTypeLabel('collect_diagnostics')).toBe('Собрать диагностику');
    expect(onecCommandTypeLabel('rotate_certificate_hint')).toBe('Запросить смену сертификата');
    expect(onecCommandTypeLabel('mystery_command')).toBe('mystery_command');
  });

  it('has a one-line description for every operator-sendable command type', () => {
    const types = [
      'start_full_sync',
      'reload_entity',
      'pause_etl',
      'resume_etl',
      'run_connectivity_test',
      'collect_diagnostics',
      'rotate_certificate_hint',
      'integration_probe',
    ];
    for (const type of types) {
      expect(onecCommandTypeDescription(type).length).toBeGreaterThan(0);
    }
    expect(onecCommandTypeDescription('mystery_command')).toBe('');
  });
});

describe('onecCommandStatusLabel / onecCommandStatusColor', () => {
  it('maps every command status to a Russian label and the spec-mandated color band', () => {
    expect(onecCommandStatusLabel('queued')).toBe('В очереди');
    expect(onecCommandStatusColor('queued')).toBe('blue');
    expect(onecCommandStatusColor('leased')).toBe('blue');
    expect(onecCommandStatusColor('received')).toBe('processing');
    expect(onecCommandStatusColor('succeeded')).toBe('green');
    expect(onecCommandStatusColor('business_error')).toBe('orange');
    expect(onecCommandStatusColor('dead_letter')).toBe('red');
    expect(onecCommandStatusColor('expired')).toBe('default');
    expect(onecCommandStatusColor('expired_undelivered')).toBe('default');
    expect(onecCommandStatusColor('cancelled')).toBeUndefined();
  });

  it('falls back to the raw value for an unknown status', () => {
    expect(onecCommandStatusLabel('mystery')).toBe('mystery');
    expect(onecCommandStatusColor('mystery')).toBeUndefined();
  });
});

describe('onecCommandCancellable', () => {
  it('only queued and leased commands may be cancelled (spec §4.7)', () => {
    expect(onecCommandCancellable('queued')).toBe(true);
    expect(onecCommandCancellable('leased')).toBe(true);
    expect(onecCommandCancellable('received')).toBe(false);
    expect(onecCommandCancellable('succeeded')).toBe(false);
    expect(onecCommandCancellable('business_error')).toBe(false);
    expect(onecCommandCancellable('dead_letter')).toBe(false);
    expect(onecCommandCancellable('expired')).toBe(false);
    expect(onecCommandCancellable('expired_undelivered')).toBe(false);
    expect(onecCommandCancellable('cancelled')).toBe(false);
  });
});

describe('onecCommandSourceLabel', () => {
  it('names the operator for onec_admin, falling back to the raw module otherwise', () => {
    expect(onecCommandSourceLabel({ sourceModule: 'onec_admin', requestedBy: { userId: '1', displayName: 'Иванов И.И.' } })).toBe(
      'Администратор: Иванов И.И.',
    );
    expect(onecCommandSourceLabel({ sourceModule: 'onec_admin', requestedBy: null })).toBe('Администратор');
    expect(onecCommandSourceLabel({ sourceModule: 'orders', requestedBy: null })).toBe('orders');
  });
});

describe('onecDefaultProbeMarker', () => {
  it('embeds the local time so repeated probes are distinguishable', () => {
    const now = new Date('2026-09-28T10:15:00Z');
    expect(onecDefaultProbeMarker(now)).toBe(`ERP probe ${now.toLocaleString('ru-RU')}`);
  });
});

describe('onecCommandPayloadFromForm', () => {
  it('builds start_full_sync with the given entities (empty = all enabled entities)', () => {
    expect(onecCommandPayloadFromForm('start_full_sync', { entities: ['orders', 'clients'] })).toEqual({
      entities: ['orders', 'clients'],
    });
    expect(onecCommandPayloadFromForm('start_full_sync', {})).toEqual({ entities: [] });
    expect(onecCommandPayloadFromForm('start_full_sync', { entities: [] })).toEqual({ entities: [] });
  });

  it('builds reload_entity with a single trimmed entity code', () => {
    expect(onecCommandPayloadFromForm('reload_entity', { entity: '  orders  ' })).toEqual({ entity: 'orders' });
  });

  it('builds integration_probe with a trimmed marker', () => {
    expect(onecCommandPayloadFromForm('integration_probe', { marker: '  ERP probe test  ' })).toEqual({
      marker: 'ERP probe test',
    });
  });

  it('builds an empty object for every no-field admin command', () => {
    for (const type of ['pause_etl', 'resume_etl', 'run_connectivity_test', 'collect_diagnostics', 'rotate_certificate_hint']) {
      expect(onecCommandPayloadFromForm(type, { entities: ['x'], entity: 'y', marker: 'z' })).toEqual({});
    }
  });

  it('omits unrelated fields for an unknown command type', () => {
    expect(onecCommandPayloadFromForm('unknown_type', { entities: ['x'], entity: 'y', marker: 'z' })).toEqual({});
  });
});

describe('onecAlertResolvable', () => {
  it('lets the operator close only unresolved one-shot command alerts', () => {
    expect(onecAlertResolvable('command_dead_letter', 'open')).toBe(true);
    expect(onecAlertResolvable('command_expired_undelivered', 'acknowledged')).toBe(true);
    expect(onecAlertResolvable('command_dead_letter', 'resolved')).toBe(false);
    expect(onecAlertResolvable('agent_silent', 'open')).toBe(false);
  });
});
