import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, Select, Space, Spin, Switch, Table, Tag, Typography, message } from 'antd';
import { SaveOutlined, ArrowUpOutlined, ArrowDownOutlined, ReloadOutlined } from '@ant-design/icons';
import { useInvalidate, useList, useUpdate } from '@refinedev/core';
import { useAppSettings, SETTING_KEYS } from '../../../hooks/useAppSettings';
import {
  ProductionStatusRef,
  ProductionWorkflowConfig,
  buildDefaultProductionWorkflowConfig,
  normalizeProductionWorkflowConfig,
} from '../../../types/productionWorkflow';

const { Text } = Typography;

const WORKFLOW_KEY = SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT;

const moveItem = <T,>(arr: T[], from: number, to: number) => {
  if (from === to) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const normalizeLetter = (value: string) => (value || '').trim().slice(0, 1).toUpperCase();

type ValidationItem = { level: 'error' | 'warning'; message: string };

const uniq = (arr: string[]) => Array.from(new Set(arr));

const findDuplicates = (arr: string[]) => {
  const seen = new Set<string>();
  const dups = new Set<string>();
  arr.forEach((x) => {
    if (seen.has(x)) dups.add(x);
    seen.add(x);
  });
  return Array.from(dups);
};

const validateWorkflow = (draft: ProductionWorkflowConfig, knownCodesSet: Set<string>): ValidationItem[] => {
  const items: ValidationItem[] = [];

  const orderAllowed = draft.order.allowed_codes || [];
  const detailAllowed = draft.detail.allowed_codes || [];
  const orderAllowedSet = new Set(orderAllowed);
  const detailAllowedSet = new Set(detailAllowed);

  const orderUnknown = orderAllowed.filter((c) => !knownCodesSet.has(c));
  if (orderUnknown.length > 0) {
    items.push({ level: 'warning', message: `Заказ: allowed_codes содержит неизвестные коды: ${uniq(orderUnknown).join(', ')}` });
  }

  const detailUnknown = detailAllowed.filter((c) => !knownCodesSet.has(c));
  if (detailUnknown.length > 0) {
    items.push({ level: 'warning', message: `Деталь: allowed_codes содержит неизвестные коды: ${uniq(detailUnknown).join(', ')}` });
  }

  if (!orderAllowedSet.has(draft.order.initial_code)) {
    items.push({ level: 'error', message: `Заказ: initial_code "${draft.order.initial_code}" не входит в allowed_codes` });
  }
  if (!detailAllowedSet.has(draft.detail.initial_code)) {
    items.push({ level: 'error', message: `Деталь: initial_code "${draft.detail.initial_code}" не входит в allowed_codes` });
  }

  const displayOrder = draft.status_codes_order || [];
  const displayDups = findDuplicates(displayOrder);
  if (displayDups.length > 0) {
    items.push({ level: 'error', message: `status_codes_order содержит дубликаты: ${displayDups.join(', ')}` });
  }

  const displayUnknown = displayOrder.filter((c) => !knownCodesSet.has(c));
  if (displayUnknown.length > 0) {
    items.push({ level: 'error', message: `status_codes_order содержит неизвестные коды: ${uniq(displayUnknown).join(', ')}` });
  }

  // transitions_order validation
  const transitionsOrder = draft.transitions_order || {};
  Object.entries(transitionsOrder).forEach(([from, tos]) => {
    if (!Array.isArray(tos)) return;
    if (!knownCodesSet.has(from)) {
      items.push({ level: 'error', message: `transitions_order: неизвестный ключ "${from}"` });
      return;
    }
    if (!orderAllowedSet.has(from)) {
      items.push({ level: 'warning', message: `transitions_order: "${from}" не входит в order.allowed_codes` });
    }
    const badTargets = tos.filter((to) => !orderAllowedSet.has(to));
    if (badTargets.length > 0) {
      items.push({
        level: 'error',
        message: `transitions_order: для "${from}" есть переходы вне order.allowed_codes: ${uniq(badTargets).join(', ')}`,
      });
    }
  });

  // transitions_detail validation
  const transitionsDetail = draft.transitions_detail || {};
  Object.entries(transitionsDetail).forEach(([from, tos]) => {
    if (!Array.isArray(tos)) return;
    if (!knownCodesSet.has(from)) {
      items.push({ level: 'error', message: `transitions_detail: неизвестный ключ "${from}"` });
      return;
    }
    if (!detailAllowedSet.has(from)) {
      items.push({ level: 'warning', message: `transitions_detail: "${from}" не входит в detail.allowed_codes` });
    }
    const badTargets = tos.filter((to) => !detailAllowedSet.has(to));
    if (badTargets.length > 0) {
      items.push({
        level: 'error',
        message: `transitions_detail: для "${from}" есть переходы вне detail.allowed_codes: ${uniq(badTargets).join(', ')}`,
      });
    }
  });

  // letters_by_code validation (temporary “icons”)
  const letters = draft.letters_by_code || {};
  Object.entries(letters).forEach(([code, val]) => {
    if (!knownCodesSet.has(code)) return;
    const normalized = normalizeLetter(String(val ?? ''));
    if (!normalized || normalized.length !== 1) {
      items.push({ level: 'warning', message: `letters_by_code: для "${code}" задан пустой символ` });
    }
  });

  return items;
};

export const ProductionWorkflowTab: React.FC = () => {
  const { getSettingRecord, saveSetting, setSettingActive, isLoading: settingsLoading } = useAppSettings();
  const invalidate = useInvalidate();
  const { mutateAsync: updateProductionStatus } = useUpdate();

  const { data: statusesData, isLoading: statusesLoading, refetch: refetchStatuses } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 200 },
    // IMPORTANT: explicit is_active filter disables the dataProvider auto-filter, so we can show ALL statuses
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });

  const statuses: ProductionStatusRef[] = useMemo(() => {
    return (statusesData?.data || []).map((s: any) => ({
      production_status_id: s.production_status_id,
      production_status_code: s.production_status_code,
      production_status_name: s.production_status_name,
      sort_order: s.sort_order,
      color: s.color,
      is_active: !!s.is_active,
    }));
  }, [statusesData]);

  const workflowRecord = getSettingRecord(WORKFLOW_KEY);
  const workflowIsActive = workflowRecord?.is_active ?? false;
  const savedWorkflow = useMemo(() => {
    if (!workflowRecord) return null;
    const json = workflowRecord.value_json;
    if (json && typeof json === 'object' && 'value' in json) {
      return (json as any).value as ProductionWorkflowConfig;
    }
    return json as ProductionWorkflowConfig;
  }, [workflowRecord]);

  const normalizedWorkflow = useMemo(() => {
    if (!statuses || statuses.length === 0) {
      return savedWorkflow || null;
    }
    return normalizeProductionWorkflowConfig(savedWorkflow, statuses, WORKFLOW_KEY);
  }, [savedWorkflow, statuses]);

  const [draft, setDraft] = useState<ProductionWorkflowConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isTogglingSettingActive, setIsTogglingSettingActive] = useState(false);

  // Initialize draft once statuses are available (avoid resetting while editing)
  useEffect(() => {
    if (draft) return;
    if (settingsLoading || statusesLoading) return;
    if (statuses.length === 0) return;
    setDraft(
      normalizedWorkflow
        ? normalizeProductionWorkflowConfig(normalizedWorkflow, statuses, WORKFLOW_KEY)
        : buildDefaultProductionWorkflowConfig(statuses, WORKFLOW_KEY)
    );
  }, [draft, settingsLoading, statusesLoading, statuses, normalizedWorkflow]);

  const statusByCode = useMemo(() => {
    const map = new Map<string, ProductionStatusRef>();
    statuses.forEach((s) => map.set(s.production_status_code, s));
    return map;
  }, [statuses]);

  const missingCodes = useMemo(() => {
    const codes = draft?.status_codes_order || [];
    return codes.filter((code) => !statusByCode.has(code));
  }, [draft?.status_codes_order, statusByCode]);

  const knownCodes = useMemo(() => {
    return statuses.map((s) => s.production_status_code);
  }, [statuses]);
  const knownCodesSet = useMemo(() => new Set(knownCodes), [knownCodes]);

  const usedOrder = useMemo(() => new Set(draft?.order.allowed_codes || []), [draft?.order.allowed_codes]);
  const usedDetail = useMemo(() => new Set(draft?.detail.allowed_codes || []), [draft?.detail.allowed_codes]);
  const inDisplayOrder = useMemo(() => new Set(draft?.status_codes_order || []), [draft?.status_codes_order]);

  const validationItems = useMemo(() => {
    if (!draft) return [];
    return validateWorkflow(draft, knownCodesSet);
  }, [draft, knownCodesSet]);

  const validationErrors = useMemo(() => validationItems.filter((i) => i.level === 'error'), [validationItems]);
  const validationWarnings = useMemo(() => validationItems.filter((i) => i.level === 'warning'), [validationItems]);

  const setAndDirty = (next: ProductionWorkflowConfig) => {
    setDraft(next);
    setIsDirty(true);
  };

  const handleReset = () => {
    if (statuses.length === 0) return;
    const next = normalizedWorkflow
      ? normalizeProductionWorkflowConfig(normalizedWorkflow, statuses, WORKFLOW_KEY)
      : buildDefaultProductionWorkflowConfig(statuses, WORKFLOW_KEY);
    setDraft(next);
    setIsDirty(false);
    message.info('Черновик сброшен к сохранённой версии');
  };

  const handleSave = async () => {
    if (!draft) return;
    if (validationErrors.length > 0) {
      message.error('Нельзя сохранить: исправьте ошибки в конфигурации');
      return;
    }
    setIsSaving(true);
    try {
      await saveSetting(
        WORKFLOW_KEY,
        draft,
        'Workflow производства (production_status_events) + буквы этапов (временное хранение в app_settings)'
      );
      setIsDirty(false);
      message.success('Workflow сохранён');
    } catch (e) {
      message.error('Не удалось сохранить workflow');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleWorkflowSettingActive = async (nextActive: boolean) => {
    if (!draft) return;
    setIsTogglingSettingActive(true);
    try {
      if (nextActive) {
        if (validationErrors.length > 0) {
          message.error('Нельзя активировать: исправьте ошибки в конфигурации');
          return;
        }
        // Enabling: persist current draft to ensure value_json is valid workflow config
        await saveSetting(
          WORKFLOW_KEY,
          draft,
          'Workflow производства (production_status_events) + буквы этапов (временное хранение в app_settings)'
        );
        setIsDirty(false);
        message.success('Настройка workflow активирована');
      } else {
        await setSettingActive(WORKFLOW_KEY, false);
        message.info('Настройка workflow деактивирована');
      }
    } catch (e) {
      message.error('Не удалось изменить активность настройки');
    } finally {
      setIsTogglingSettingActive(false);
    }
  };

  if (settingsLoading || statusesLoading || !draft) {
    return (
      <div style={{ padding: '16px 0' }}>
        <Spin />
      </div>
    );
  }

  const allCodesOptions = knownCodes.map((code) => {
    const s = statusByCode.get(code);
    const name = s?.production_status_name || code;
    const active = s?.is_active;
    const letter = normalizeLetter(draft.letters_by_code?.[code] || '');
    return {
      value: code,
      label: (
        <Space size={8}>
          <Tag color={active ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
            {letter || '—'}
          </Tag>
          <span>{name}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            ({code})
          </Text>
        </Space>
      ),
    };
  });

  return (
    <div style={{ padding: '16px 0' }}>
      <Alert
        type="info"
        showIcon
        message="Workflow этапов производства"
        description={
          <div>
            <div>
              Ключ настройки: <Text code>{WORKFLOW_KEY}</Text>
            </div>
            <div>
              События хранятся в <Text code>production_status_events</Text>, а правила/буквы — в{' '}
              <Text code>app_settings.value_json</Text>.
            </div>
            {missingCodes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Text type="danger">
                  В конфиге есть коды, которых нет в справочнике: {missingCodes.join(', ')}
                </Text>
              </div>
            )}
          </div>
        }
        style={{ marginBottom: 16 }}
      />

      {(validationErrors.length > 0 || validationWarnings.length > 0) && (
        <Alert
          type={validationErrors.length > 0 ? 'error' : 'warning'}
          showIcon
          message={`Проверка конфигурации: ошибок ${validationErrors.length}, предупреждений ${validationWarnings.length}`}
          description={
            <div>
              {validationErrors.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <Text strong style={{ color: '#cf1322' }}>Ошибки:</Text>
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {validationErrors.slice(0, 8).map((e, idx) => (
                      <li key={`e-${idx}`}>{e.message}</li>
                    ))}
                  </ul>
                  {validationErrors.length > 8 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Показаны первые 8 ошибок…
                    </Text>
                  )}
                </div>
              )}

              {validationWarnings.length > 0 && (
                <div>
                  <Text strong style={{ color: '#ad6800' }}>Предупреждения:</Text>
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {validationWarnings.slice(0, 8).map((w, idx) => (
                      <li key={`w-${idx}`}>{w.message}</li>
                    ))}
                  </ul>
                  {validationWarnings.length > 8 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Показаны первые 8 предупреждений…
                    </Text>
                  )}
                </div>
              )}
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        size="small"
        title="Порядок этапов (status_codes_order)"
        extra={
          <Space>
            <Space size={8}>
              <Text type="secondary">is_active:</Text>
              <Switch
                checked={workflowIsActive}
                loading={isTogglingSettingActive}
                onChange={handleToggleWorkflowSettingActive}
                disabled={validationErrors.length > 0}
              />
            </Space>
            <Button onClick={() => refetchStatuses()}>Обновить статусы</Button>
            <Button icon={<ReloadOutlined />} onClick={handleReset} disabled={!isDirty}>
              Сбросить
            </Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={isSaving} disabled={!isDirty}>
              Сохранить
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Этот порядок используется для отображения букв на карточках/в списках. Новые статусы можно добавить в
              список.
            </Text>
          </div>

          <Space wrap>
            <Text strong style={{ minWidth: 190 }}>
              Добавить этап в порядок:
            </Text>
            <Select
              style={{ minWidth: 360 }}
              placeholder="Выберите статус"
              options={allCodesOptions.filter((o) => !inDisplayOrder.has(o.value as string))}
              onChange={(code) => {
                const next = {
                  ...draft,
                  status_codes_order: [...draft.status_codes_order, code],
                };
                setAndDirty(next);
              }}
            />
          </Space>

          <Table
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={draft.status_codes_order.map((code, index) => ({
              index,
              code,
              status: statusByCode.get(code),
            }))}
            columns={[
              {
                title: '#',
                dataIndex: 'index',
                width: 46,
                render: (i: number) => <Text type="secondary">{i + 1}</Text>,
              },
              {
                title: 'Этап',
                dataIndex: 'code',
                render: (_: any, row: any) => {
                  const s: ProductionStatusRef | undefined = row.status;
                  const letter = normalizeLetter(draft.letters_by_code?.[row.code] || '');
                  return (
                    <Space size={8}>
                      <Tag color={s?.is_active ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
                        {letter || '—'}
                      </Tag>
                      <span>{s?.production_status_name || row.code}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        ({row.code})
                      </Text>
                    </Space>
                  );
                },
              },
              {
                title: '',
                key: 'actions',
                width: 120,
                render: (_: any, row: any) => {
                  const idx = row.index as number;
                  return (
                    <Space>
                      <Button
                        size="small"
                        icon={<ArrowUpOutlined />}
                        disabled={idx <= 0}
                        onClick={() => setAndDirty({ ...draft, status_codes_order: moveItem(draft.status_codes_order, idx, idx - 1) })}
                      />
                      <Button
                        size="small"
                        icon={<ArrowDownOutlined />}
                        disabled={idx >= draft.status_codes_order.length - 1}
                        onClick={() => setAndDirty({ ...draft, status_codes_order: moveItem(draft.status_codes_order, idx, idx + 1) })}
                      />
                      <Button
                        size="small"
                        danger
                        onClick={() =>
                          setAndDirty({
                            ...draft,
                            status_codes_order: draft.status_codes_order.filter((c) => c !== row.code),
                          })
                        }
                      >
                        Убрать
                      </Button>
                    </Space>
                  );
                },
              },
            ]}
          />
        </Space>
      </Card>

      <Card size="small" title="Переходы (transitions)" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Переходы хранятся по <Text code>production_status_code</Text>. Это используется как правило workflow (в меню можно
            подсвечивать/ограничивать “следующие” этапы).
          </Text>

          <Space wrap>
            <Button
              onClick={() => {
                const orderTransitions: Record<string, string[]> = {};
                const detailTransitions: Record<string, string[]> = {};
                draft.status_codes_order.forEach((code, idx) => {
                  const next = draft.status_codes_order[idx + 1];
                  if (!next) return;
                  if (usedOrder.has(code) && usedOrder.has(next)) orderTransitions[code] = [next];
                  if (usedDetail.has(code) && usedDetail.has(next)) detailTransitions[code] = [next];
                });
                setAndDirty({
                  ...draft,
                  transitions_order: orderTransitions,
                  transitions_detail: detailTransitions,
                });
              }}
            >
              Сгенерировать линейные переходы
            </Button>
          </Space>

          <Text strong>Заказ</Text>
          <Table
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={draft.status_codes_order.filter((c) => usedOrder.has(c)).map((code) => ({
              code,
              name: statusByCode.get(code)?.production_status_name || code,
              allowed: draft.transitions_order?.[code] || [],
            }))}
            columns={[
              {
                title: 'Этап',
                dataIndex: 'code',
                render: (_: any, row: any) => (
                  <Space size={8}>
                    <Text>{row.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      ({row.code})
                    </Text>
                  </Space>
                ),
              },
              {
                title: 'Можно перейти в',
                dataIndex: 'allowed',
                render: (allowed: string[], row: any) => (
                  <Select
                    mode="multiple"
                    style={{ width: '100%' }}
                    placeholder="—"
                    value={allowed}
                    options={allCodesOptions.filter((o) => usedOrder.has(o.value as string))}
                    onChange={(nextCodes) =>
                      setAndDirty({
                        ...draft,
                        transitions_order: { ...(draft.transitions_order || {}), [row.code]: nextCodes },
                      })
                    }
                  />
                ),
              },
            ]}
          />

          <Text strong>Деталь</Text>
          <Table
            size="small"
            pagination={false}
            rowKey="code"
            dataSource={draft.status_codes_order.filter((c) => usedDetail.has(c)).map((code) => ({
              code,
              name: statusByCode.get(code)?.production_status_name || code,
              allowed: draft.transitions_detail?.[code] || [],
            }))}
            columns={[
              {
                title: 'Этап',
                dataIndex: 'code',
                render: (_: any, row: any) => (
                  <Space size={8}>
                    <Text>{row.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      ({row.code})
                    </Text>
                  </Space>
                ),
              },
              {
                title: 'Можно перейти в',
                dataIndex: 'allowed',
                render: (allowed: string[], row: any) => (
                  <Select
                    mode="multiple"
                    style={{ width: '100%' }}
                    placeholder="—"
                    value={allowed}
                    options={allCodesOptions.filter((o) => usedDetail.has(o.value as string))}
                    onChange={(nextCodes) =>
                      setAndDirty({
                        ...draft,
                        transitions_detail: { ...(draft.transitions_detail || {}), [row.code]: nextCodes },
                      })
                    }
                  />
                ),
              },
            ]}
          />
        </Space>
      </Card>

      <Card size="small" title="Статусы производства и использование в workflow">
        <Table
          size="small"
          pagination={false}
          rowKey="production_status_id"
          dataSource={statuses}
          columns={[
            {
              title: 'Активен',
              dataIndex: 'is_active',
              width: 78,
              render: (v: boolean, row: ProductionStatusRef) => (
                <Switch
                  checked={v}
                  onChange={async (next) => {
                    try {
                      await updateProductionStatus({
                        resource: 'production_statuses',
                        id: row.production_status_id,
                        values: { is_active: next },
                      });
                      await invalidate({ resource: 'production_statuses', invalidates: ['list'] });
                      refetchStatuses();
                      message.success(next ? 'Статус активирован' : 'Статус деактивирован');
                    } catch (e) {
                      message.error('Не удалось обновить is_active');
                    }
                  }}
                />
              ),
            },
            { title: 'Порядок', dataIndex: 'sort_order', width: 78 },
            {
              title: 'Буква',
              dataIndex: 'production_status_code',
              width: 78,
              render: (code: string) => (
                <Input
                  value={draft.letters_by_code?.[code] || ''}
                  maxLength={1}
                  style={{ width: 54, textAlign: 'center' }}
                  onChange={(e) => {
                    const value = normalizeLetter(e.target.value);
                    setAndDirty({
                      ...draft,
                      letters_by_code: { ...(draft.letters_by_code || {}), [code]: value },
                    });
                  }}
                />
              ),
            },
            {
              title: 'Название',
              dataIndex: 'production_status_name',
              render: (name: string, row: ProductionStatusRef) => (
                <Space size={8}>
                  <span>{name}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({row.production_status_code})
                  </Text>
                </Space>
              ),
            },
            {
              title: 'Workflow (заказ)',
              dataIndex: 'production_status_code',
              width: 140,
              render: (code: string) => (
                <Checkbox
                  checked={usedOrder.has(code)}
                  onChange={(e) => {
                    const nextAllowed = e.target.checked
                      ? Array.from(new Set([...draft.order.allowed_codes, code]))
                      : draft.order.allowed_codes.filter((c) => c !== code);
                    setAndDirty({
                      ...draft,
                      order: { ...draft.order, allowed_codes: nextAllowed },
                    });
                  }}
                />
              ),
            },
            {
              title: 'Workflow (деталь)',
              dataIndex: 'production_status_code',
              width: 140,
              render: (code: string) => (
                <Checkbox
                  checked={usedDetail.has(code)}
                  onChange={(e) => {
                    const nextAllowed = e.target.checked
                      ? Array.from(new Set([...draft.detail.allowed_codes, code]))
                      : draft.detail.allowed_codes.filter((c) => c !== code);
                    setAndDirty({
                      ...draft,
                      detail: { ...draft.detail, allowed_codes: nextAllowed },
                    });
                  }}
                />
              ),
            },
            {
              title: 'В порядке',
              dataIndex: 'production_status_code',
              width: 100,
              render: (code: string) => (
                <Tag color={inDisplayOrder.has(code) ? 'blue' : 'default'}>
                  {inDisplayOrder.has(code) ? 'Да' : 'Нет'}
                </Tag>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default ProductionWorkflowTab;
