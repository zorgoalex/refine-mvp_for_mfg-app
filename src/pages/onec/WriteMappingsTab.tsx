import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { formatDate } from '../../utils/dateFormat';
import {
  defaultWriteMappingAgent, onecValueLabel, onecWriteMappingsApi,
  type OnecWriteMappingCandidate, type OnecWriteMappingItem, type OnecWriteMappingKindView,
} from './onecWriteMappings';

const { Text } = Typography;
const SEARCH_DEBOUNCE_MS = 300;

/** Picker of a live 1C mirror object for one ERP item; the current mapping is always an option. */
function RefPicker({ agentId, kind, item, disabled, onPick }: {
  agentId: string; kind: string; item: OnecWriteMappingItem; disabled: boolean; onPick: (ref: string | null) => void;
}) {
  const [options, setOptions] = useState<OnecWriteMappingCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const load = useCallback((search: string) => {
    const current = ++generation.current;
    setLoading(true);
    onecWriteMappingsApi.candidates(agentId, kind, search)
      .then((result) => { if (current === generation.current) setOptions(result.data); })
      .catch(() => { if (current === generation.current) setOptions([]); })
      .finally(() => { if (current === generation.current) setLoading(false); });
  }, [agentId, kind]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const mapped = item.mapping?.onecRef ?? null;
  const merged = useMemo(() => {
    const list = options.map((option) => ({ value: option.ref, label: `${option.name ?? '—'}${option.code ? ` (${option.code})` : ''}` }));
    if (mapped && !list.some((option) => option.value === mapped)) list.unshift({ value: mapped, label: item.mapping?.onecName ?? mapped });
    return list;
  }, [options, mapped, item.mapping?.onecName]);

  return (
    <Select<string>
      showSearch
      allowClear
      style={{ minWidth: 320, maxWidth: 480 }}
      placeholder="Объект 1С"
      value={mapped ?? undefined}
      options={merged}
      filterOption={false}
      loading={loading}
      disabled={disabled}
      onDropdownVisibleChange={(open) => { if (open && options.length === 0) load(''); }}
      onSearch={(value) => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => load(value), SEARCH_DEBOUNCE_MS);
      }}
      onChange={(value) => onPick(value ?? null)}
      notFoundContent={loading ? <Spin size="small" /> : 'Нет объектов 1С'}
    />
  );
}

function KindPanel({ agentId, kind, onSaved }: { agentId: string; kind: OnecWriteMappingKindView; onSaved: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const save = async (item: OnecWriteMappingItem, next: { onecRef: string | null; onecValue: Record<string, unknown> | null }) => {
    setSaving(item.erpKey);
    try {
      await onecWriteMappingsApi.put(agentId, kind.kind, item.erpKey, { ...next, expectedVersion: item.mapping?.version ?? null });
      message.success('Связь сохранена');
      onSaved();
    } catch (error) {
      if (isApiError(error, 'ONEC_MAPPING_CHANGED')) message.warning('Связь уже изменили — список обновлён');
      else if (isApiError(error, 'ONEC_MAPPING_REF_INVALID')) message.error('Этот объект 1С нельзя выбрать (удалён или другого вида)');
      else message.error('Не удалось сохранить связь');
      onSaved();
    } finally {
      setSaving(null);
    }
  };

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {kind.pendingNote && <Alert type="info" showIcon message={kind.pendingNote} />}
      {kind.items.map((item) => {
        const value = item.mapping?.onecValue ?? null;
        const field = kind.valueOptions?.field;
        return (
          <div key={item.erpKey} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Text style={{ minWidth: 220 }}>{item.label}</Text>
            {kind.hasRef && (
              <RefPicker key={`${agentId}:${item.erpKey}`} agentId={agentId} kind={kind.kind} item={item} disabled={saving === item.erpKey}
                onPick={(ref) => void save(item, { onecRef: ref, onecValue: ref === null ? null : value })} />
            )}
            {kind.valueOptions && field && (
              <Select<string>
                style={{ minWidth: 180 }}
                allowClear={kind.kind === 'order_status'}
                placeholder={kind.kind === 'order_status' ? 'Завершение (для «Завершен»)' : 'Производственный статус 1С'}
                disabled={saving === item.erpKey || (kind.hasRef && !item.mapping?.onecRef)}
                value={value && field in value ? String(value[field] ?? '') : undefined}
                options={[
                  ...(kind.valueOptions.nullable && kind.kind === 'production_stage' ? [{ value: '', label: onecValueLabel(null) }] : []),
                  ...kind.valueOptions.values.map((option) => ({ value: option, label: onecValueLabel(option) })),
                ]}
                onChange={(next) => {
                  const fieldValue = next === undefined ? undefined : next === '' ? null : next;
                  const onecValue = fieldValue === undefined ? null : { [field]: fieldValue };
                  void save(item, { onecRef: item.mapping?.onecRef ?? null, onecValue });
                }}
              />
            )}
            {item.mapping?.onecRefStale && <Tag color="error">объект 1С недействителен (удалён, помечен или не подходит)</Tag>}
            {!item.mapping && <Tag color="warning">не связано</Tag>}
            {item.mapping && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {item.mapping.updatedBy ?? '—'}, {formatDate(item.mapping.updatedAt)}
              </Text>
            )}
          </div>
        );
      })}
    </Space>
  );
}

/**
 * «Интеграция 1С → Связи для записи в 1С»: which 1C object each ERP item becomes when ERP creates documents in 1C
 * (plan 2026-11-04). Nothing is sent to 1C here. Visible with onec.write.mappings.
 */
export function WriteMappingsTab({ agents }: { agents: ReadonlyArray<{ agentId: string; status: string }> }) {
  const [agentId, setAgentId] = useState(() => defaultWriteMappingAgent(agents));
  // Loaded data is bound to the agent it belongs to: after a switch nothing of the previous source is shown or saved.
  const [loaded, setLoaded] = useState<{ agentId: string; kinds: OnecWriteMappingKindView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;
  const load = useCallback(() => {
    if (!agentId) return;
    const current = ++generation.current;
    const target = agentId;
    onecWriteMappingsApi.list(target)
      .then((result) => { if (current === generation.current) { setLoaded({ agentId: target, kinds: result.kinds }); setError(null); } })
      .catch(() => { if (current === generation.current) setError('Не удалось загрузить связи'); });
  }, [agentId]);
  useEffect(() => { load(); }, [load]);
  const switchAgent = (next: string) => {
    generation.current += 1; // a late answer for the previous agent is ignored
    setLoaded(null);
    setError(null);
    setAgentId(next);
  };
  const kinds = loaded && loaded.agentId === agentId ? loaded.kinds : null;
  /** Refresh after a save — only if that save belongs to the agent still selected (a late answer of a switched-away
   * agent must not invalidate the new agent's request). */
  const refreshAfterSave = (savedFor: string) => {
    if (savedFor === currentAgent.current) load();
  };

  if (!agentId) return <Alert type="info" showIcon message="Нет агентов 1С" />;
  const missing = kinds?.reduce((sum, kind) => sum + kind.missing, 0) ?? 0;
  const invalid = kinds?.reduce((sum, kind) => sum + kind.invalid, 0) ?? 0;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Связи используются, когда ERP создаёт документы в 1С (этап 1 — пока не включён). Здесь ничего не отправляется в 1С."
      />
      <Space wrap>
        <Select style={{ minWidth: 240 }} value={agentId} onChange={switchAgent}
          options={agents.map((agent) => ({ value: agent.agentId, label: `${agent.agentId}${agent.status === 'active' ? '' : ' (заблокирован)'}` }))} />
        <Button onClick={load}>Обновить</Button>
        {kinds && <Text type={missing + invalid > 0 ? 'warning' : 'secondary'}>Не связано: {missing}; недействительно: {invalid}</Text>}
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      {!kinds && !error && <Spin />}
      {kinds && (
        <Collapse>
          {kinds.map((kind) => (
            <Collapse.Panel
              key={kind.kind}
              header={<span>{kind.label} {kind.missing > 0 && <Tag color="warning">не связано: {kind.missing}</Tag>}{kind.invalid > 0 && <Tag color="error">недействительно: {kind.invalid}</Tag>}{kind.ready && <Tag color="success">готово</Tag>}</span>}
            >
              <KindPanel key={`${agentId}:${kind.kind}`} agentId={agentId} kind={kind} onSaved={() => refreshAfterSave(agentId)} />
            </Collapse.Panel>
          ))}
        </Collapse>
      )}
    </Space>
  );
}
