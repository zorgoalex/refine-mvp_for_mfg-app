import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Drawer, Modal, Radio, Space, Spin, Tag, Timeline, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { ApiError, isApiError } from '../../api/apiError';
import { integrationDuplicatesApi } from '../../api/integrationDuplicatesApi';
import type { DuplicateCaseDetail, DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import {
  DUPLICATE_REASONS,
  DUPLICATE_STATUS_COLORS,
  DUPLICATE_STATUS_LABELS,
  DUPLICATE_STRENGTH_LABELS,
  DUPLICATE_SYSTEM_COLORS,
  DUPLICATE_SYSTEM_LABELS,
  actionLabel,
  availableActions,
  commandAllowed,
  formatDateTime,
  type DuplicateReason,
  keyMaskText,
  memberErpLink,
  memberName,
  resolutionLabel,
  statusLabel,
  userText,
  viaLabel,
} from './duplicatesModel';

const { Text } = Typography;

type CommandAction = 'dismiss' | 'external' | 'reopen';

const ACTION_TEXT: Record<CommandAction, { title: string; ok: string; done: string }> = {
  dismiss: { title: 'Отметить «Не дубль»', ok: 'Не дубль', done: 'Дело отмечено «Не дубль»' },
  external: { title: 'Отметить «Исправить в 1С»', ok: 'Исправить в 1С', done: 'Дело отмечено «Исправить в 1С»' },
  reopen: { title: 'Открыть дело снова', ok: 'Открыть снова', done: 'Дело открыто снова' },
};

function MemberCard({ member }: { member: DuplicateMemberDetail }) {
  const left = Boolean(member.leftAt);
  const link = memberErpLink(member);
  const author = member.author ? userText(member.author) : member.authorExternal || '—';
  return (
    <Card
      size="small"
      style={{ opacity: left ? 0.6 : 1, background: left ? 'rgba(0,0,0,0.03)' : undefined }}
      title={(
        <Space size={6} wrap>
          <Tag color={DUPLICATE_SYSTEM_COLORS[member.system]} style={{ marginInlineEnd: 0 }}>
            {DUPLICATE_SYSTEM_LABELS[member.system]}
          </Tag>
          <span>{member.name ? member.name : <Text type="secondary">{memberName(member)}</Text>}</span>
          {left && <Tag>ушла {formatDateTime(member.leftAt)}</Tag>}
        </Space>
      )}
      extra={link ? <Link to={link}>Открыть карточку</Link> : null}
    >
      <Descriptions size="small" column={1} colon={false}>
        {member.erpEntityId != null && <Descriptions.Item label="ID в ERP">{member.erpEntityId}</Descriptions.Item>}
        <Descriptions.Item label="Ключ записи"><Text code>{member.recordKey}</Text></Descriptions.Item>
        <Descriptions.Item label="Создана">{formatDateTime(member.recordCreatedAt)}</Descriptions.Item>
        <Descriptions.Item label="Автор">{author}</Descriptions.Item>
        <Descriptions.Item label="Как попала">{viaLabel(member.via)}</Descriptions.Item>
        <Descriptions.Item label="Совпавшие значения">
          {member.matchedValues === null
            ? <Text type="secondary">нет доступа</Text>
            : member.matchedValues.length ? member.matchedValues.join(', ') : '—'}
        </Descriptions.Item>
        {member.facts.map((fact, index) => (
          <Descriptions.Item key={`${fact.label}:${index}`} label={fact.label}>
            {fact.hidden ? <Text type="secondary">нет доступа</Text> : (fact.value ?? '—')}
          </Descriptions.Item>
        ))}
      </Descriptions>
    </Card>
  );
}

export interface DuplicateDrawerProps {
  caseId: number | null;
  canResolve: boolean;
  onSelectCase: (caseId: number) => void;
  onClose: () => void;
  onChanged: () => void;
}

export function DuplicateDrawer({ caseId, canResolve, onSelectCase, onClose, onChanged }: DuplicateDrawerProps) {
  const [card, setCard] = useState<DuplicateCaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<CommandAction | null>(null);
  const [reason, setReason] = useState<DuplicateReason | null>(null);
  const [saving, setSaving] = useState(false);
  // Only the answer of the latest load of the case shown may land: a late answer of the previous case is dropped.
  const generation = useRef(0);
  const shownCaseId = useRef<number | null>(caseId);
  shownCaseId.current = caseId;

  const load = useCallback(async (id: number) => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await integrationDuplicatesApi.detail(id);
      if (mine === generation.current && shownCaseId.current === id) setCard(loaded);
    } catch (err) {
      if (mine !== generation.current) return;
      setCard(null);
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить дело');
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPending(null);
    setReason(null);
    // The card of the previous case never stays on screen with the new title (its buttons would act on it).
    setCard(null);
    if (caseId == null) {
      generation.current += 1;
      return;
    }
    void load(caseId);
  }, [caseId, load]);

  const ready = commandAllowed(card, caseId, loading);
  const actions = card && ready ? availableActions(card, canResolve) : null;

  const submit = async () => {
    if (!card || !pending || !commandAllowed(card, shownCaseId.current, loading)) return;
    if (pending === 'dismiss' && !reason) return;
    const target = card.caseId;
    setSaving(true);
    try {
      await integrationDuplicatesApi.command(target, pending, {
        expectedVersion: card.version,
        reason: pending === 'dismiss' ? reason : null,
      });
      message.success(ACTION_TEXT[pending].done);
      setPending(null);
      setReason(null);
      // Reload so history and related cases stay complete (only if the drawer still shows this case).
      if (shownCaseId.current === target) await load(target);
      onChanged();
    } catch (err) {
      if (isApiError(err, 'DUPLICATE_CASE_CHANGED')) {
        message.warning('Дело изменилось, пока вы его смотрели. Данные обновлены — проверьте и повторите действие.');
        setPending(null);
        if (shownCaseId.current === target) await load(target);
        onChanged();
      } else if (isApiError(err, 'DUPLICATE_CASE_STATE')) {
        message.warning('В текущем состоянии дела это действие недоступно. Данные обновлены.');
        setPending(null);
        if (shownCaseId.current === target) await load(target);
        onChanged();
      } else if (isApiError(err, 'DUPLICATE_CASE_NOT_EXTERNAL')) {
        message.error('Для этого дела отметка «Исправить в 1С» не применима.');
      } else {
        message.error(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
      }
    } finally {
      setSaving(false);
    }
  };

  const footer = card && actions && (actions.dismiss || actions.external || actions.reopen) ? (
    <Space>
      {actions.dismiss && <Button onClick={() => setPending('dismiss')}>Не дубль</Button>}
      {actions.external && <Button onClick={() => setPending('external')}>Исправить в 1С</Button>}
      {actions.reopen && <Button onClick={() => setPending('reopen')}>Открыть снова</Button>}
    </Space>
  ) : null;

  return (
    <Drawer
      open={caseId != null}
      onClose={onClose}
      width={720}
      title={caseId != null ? `Дело #${caseId}` : ''}
      footer={footer}
      destroyOnClose
    >
      {loading && !card && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {card && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Правило">
              {card.ruleLabel} <Tag color={card.strength === 'exact' ? 'red' : 'gold'}>{DUPLICATE_STRENGTH_LABELS[card.strength]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Вид">{card.entityKindLabel}</Descriptions.Item>
            <Descriptions.Item label="Статус">
              <Tag color={DUPLICATE_STATUS_COLORS[card.status]}>{DUPLICATE_STATUS_LABELS[card.status]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Ключ">
              {card.keyMask ? <Text code>{card.keyMask}</Text> : <Text type="secondary">{keyMaskText(card)}</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="Обнаружено">
              {formatDateTime(card.firstDetectedAt)} · {viaLabel(card.detectedVia)}
            </Descriptions.Item>
            <Descriptions.Item label="Последнее появление">{formatDateTime(card.lastSeenAt)}</Descriptions.Item>
            {card.resolvedAt && (
              <Descriptions.Item label="Закрыто" span={2}>
                {formatDateTime(card.resolvedAt)}
                {card.resolvedBy ? ` · ${userText(card.resolvedBy)}` : ''}
                {card.resolutionCode ? ` · ${resolutionLabel(card.resolutionCode)}` : ''}
                {card.resolutionReason ? ` · ${resolutionLabel(card.resolutionReason)}` : ''}
              </Descriptions.Item>
            )}
          </Descriptions>

          <div>
            <Text strong>Участники</Text>
            <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
              {card.members.map((member) => (
                <MemberCard key={`${member.system}:${member.recordKey}`} member={member} />
              ))}
            </Space>
          </div>

          {card.related.length > 0 && (
            <div>
              <Text strong>Связанные дела</Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {card.related.map((item) => (
                    <Button key={item.caseId} size="small" onClick={() => onSelectCase(item.caseId)}>
                      #{item.caseId} · {item.ruleLabel} · {statusLabel(item.status)}
                    </Button>
                  ))}
                </Space>
              </div>
            </div>
          )}

          <div>
            <Text strong>История</Text>
            <Timeline style={{ marginTop: 12 }}>
              {card.history.map((event) => (
                <Timeline.Item key={event.eventId}>
                  <Space direction="vertical" size={0}>
                    <span>{actionLabel(event.action)}</span>
                    <Text type="secondary">
                      {formatDateTime(event.at)}{event.actor ? ` · ${userText(event.actor)}` : ''}
                      {event.reason ? ` · ${resolutionLabel(event.reason)}` : ''}
                    </Text>
                  </Space>
                </Timeline.Item>
              ))}
            </Timeline>
          </div>
        </Space>
      )}

      <Modal
        open={pending !== null}
        title={pending ? ACTION_TEXT[pending].title : ''}
        okText={pending ? ACTION_TEXT[pending].ok : 'OK'}
        cancelText="Отмена"
        confirmLoading={saving}
        okButtonProps={{ disabled: !ready || (pending === 'dismiss' && !reason) }}
        onOk={() => void submit()}
        onCancel={() => { setPending(null); setReason(null); }}
      >
        {pending === 'dismiss' ? (
          <Space direction="vertical">
            <Text>Причина</Text>
            <Radio.Group value={reason} onChange={(event) => setReason(event.target.value as DuplicateReason)}>
              <Space direction="vertical">
                {DUPLICATE_REASONS.map((code) => <Radio key={code} value={code}>{resolutionLabel(code)}</Radio>)}
              </Space>
            </Radio.Group>
          </Space>
        ) : (
          <Text>{pending ? ACTION_TEXT[pending].title : ''}?</Text>
        )}
      </Modal>
    </Drawer>
  );
}
