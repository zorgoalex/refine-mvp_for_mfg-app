import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Radio, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import { clientMergesApi } from '../../api/clientMergesApi';
import type { MergeClientView, MergeObstacle, MergePreview } from '../../api/clientMergesApiTypes';
import type { DuplicateCaseDetail } from '../../api/integrationDuplicatesApiTypes';
import { CLIENT_PERSON_TYPE_LABELS } from '../../types/clients';
import { formatDateTime, userText } from './duplicatesModel';
import {
  canConfirmMerge,
  confirmText,
  defaultSurvivorId,
  droppedContactLine,
  mergeErrorInfo,
  mergeableMembers,
  newIdempotencyKey,
  obstaclesFromDetails,
  resolveMergedId,
  warningLabel,
} from './mergeClientsModel';

const { Text } = Typography;

export interface MergeClientsModalProps {
  open: boolean;
  card: DuplicateCaseDetail | null;
  onClose: () => void;
  /** Called after a successful merge: reload the case and the list. */
  onMerged: () => void;
  /** The case changed under the dialog: reload it. */
  onCaseChanged: () => void;
}

function ClientBlock({ title, client }: { title: string; client: MergeClientView }) {
  return (
    <Descriptions size="small" column={1} bordered title={title}>
      <Descriptions.Item label="Клиент">
        <Link to={`/clients/show/${client.clientId}`}>{client.name}</Link> <Text type="secondary">#{client.clientId}</Text>
      </Descriptions.Item>
      <Descriptions.Item label="Тип">{CLIENT_PERSON_TYPE_LABELS[client.personType] ?? client.personType}</Descriptions.Item>
      <Descriptions.Item label="Создан">
        {formatDateTime(client.createdAt)}{client.createdBy ? ` · ${userText(client.createdBy)}` : ''}
      </Descriptions.Item>
      <Descriptions.Item label="Связь с 1С">{client.onecLinked ? 'есть' : 'нет'}</Descriptions.Item>
    </Descriptions>
  );
}

export function MergeClientsModal({ open, card, onClose, onMerged, onCaseChanged }: MergeClientsModalProps) {
  const members = useMemo(() => mergeableMembers(card), [card]);
  const [survivorId, setSurvivorId] = useState<number | null>(null);
  const [mergedId, setMergedId] = useState<number | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraObstacles, setExtraObstacles] = useState<MergeObstacle[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // One key per confirmation: a retry of the same request reuses it; a new preview starts a new confirmation.
  const idempotencyKey = useRef<string>(newIdempotencyKey());
  const generation = useRef(0);
  const caseId = card?.caseId ?? null;

  // Defaults are set once per opening (the case reload after a stale error must not reset the choice).
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      generation.current += 1;
      setSurvivorId(null);
      setMergedId(null);
      setPreview(null);
      setError(null);
      setExtraObstacles([]);
      setNotice(null);
      return;
    }
    if (initialized.current || !members.length) return;
    initialized.current = true;
    const survivor = defaultSurvivorId(members);
    setSurvivorId(survivor);
    setMergedId(resolveMergedId(members, survivor, null));
    idempotencyKey.current = newIdempotencyKey();
  }, [open, members]);

  const runPreview = useCallback(async () => {
    if (caseId == null || survivorId == null || mergedId == null || survivorId === mergedId) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    setExtraObstacles([]);
    try {
      const result = await clientMergesApi.preview(caseId, { survivorId, mergedId });
      if (mine !== generation.current) return;
      setPreview(result);
      idempotencyKey.current = newIdempotencyKey();
    } catch (err) {
      if (mine !== generation.current) return;
      setPreview(null);
      setError(isApiError(err)
        ? mergeErrorInfo(err.code, err.message).message
        : 'Не удалось получить предварительный расчёт');
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [caseId, survivorId, mergedId]);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    void runPreview();
  }, [open, runPreview]);

  const onSurvivorChange = (value: number) => {
    setSurvivorId(value);
    setMergedId((current) => resolveMergedId(members, value, current));
  };

  const survivorName = preview?.survivor.name ?? members.find((m) => m.clientId === survivorId)?.name ?? '';
  const mergedName = preview?.merged.name ?? members.find((m) => m.clientId === mergedId)?.name ?? '';
  const obstacles = [...(preview?.obstacles ?? []), ...extraObstacles];
  const enabled = canConfirmMerge(preview ? { obstacles } : null, loading || saving);

  const confirm = () => {
    if (!preview || caseId == null || !enabled) return;
    Modal.confirm({
      title: 'Соединить клиентов?',
      content: confirmText(preview.survivor.name, preview.merged.name),
      okText: 'Соединить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => submit(preview),
    });
  };

  const submit = async (current: MergePreview) => {
    if (caseId == null) return;
    setSaving(true);
    try {
      await clientMergesApi.merge(caseId, {
        survivorId: current.survivor.clientId,
        mergedId: current.merged.clientId,
        expectedCaseVersion: current.caseVersion,
        previewToken: current.previewToken,
        idempotencyKey: idempotencyKey.current,
      });
      message.success(`Клиент «${current.merged.name}» объединён с «${current.survivor.name}»`);
      onClose();
      onMerged();
    } catch (err) {
      if (!isApiError(err)) {
        message.error('Не удалось выполнить объединение');
        return;
      }
      const info = mergeErrorInfo(err.code, err.message);
      if (err.code === 'CLIENT_MERGE_BLOCKED') {
        setExtraObstacles(obstaclesFromDetails(err.details));
        message.error(info.message);
      } else if (info.action === 'refresh_preview') {
        setNotice(info.message);
        void runPreview();
      } else if (info.action === 'reload_case') {
        message.warning(info.message);
        onClose();
        onCaseChanged();
      } else {
        message.error(info.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const others = members.filter((m) => m.clientId !== survivorId);

  return (
    <Modal
      open={open}
      title="Соединить клиентов"
      width={760}
      onCancel={onClose}
      destroyOnClose
      footer={(
        <Space>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="primary" danger disabled={!enabled} loading={saving} onClick={confirm}>Соединить</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text strong>Клиент, который остаётся</Text>
          <div style={{ marginTop: 8 }}>
            <Radio.Group value={survivorId} onChange={(event) => onSurvivorChange(event.target.value as number)}>
              <Space direction="vertical">
                {members.map((m) => (
                  <Radio key={m.clientId} value={m.clientId}>
                    {m.name} <Text type="secondary">#{m.clientId}</Text>
                    {m.orderCount != null && <Text type="secondary"> · заказов: {m.orderCount}</Text>}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </div>
        </div>

        <div>
          <Text strong>Клиент, который объединяется (станет архивным)</Text>
          <div style={{ marginTop: 8 }}>
            {others.length > 1 ? (
              <Select
                style={{ width: '100%' }}
                value={mergedId}
                onChange={(value) => setMergedId(value)}
                options={others.map((m) => ({ value: m.clientId, label: `${m.name} #${m.clientId}` }))}
              />
            ) : (
              <Text>{others[0] ? `${others[0].name} #${others[0].clientId}` : '—'}</Text>
            )}
          </div>
        </div>

        {loading && <Spin />}
        {notice && <Alert type="info" showIcon message={notice} />}
        {error && <Alert type="error" showIcon message={error} />}

        {preview && (
          <>
            {obstacles.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="Объединить сейчас нельзя"
                description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{obstacles.map((o, i) => <li key={`${o.code}:${i}`}>{o.message}</li>)}</ul>}
              />
            )}
            {preview.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Обратите внимание"
                description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{preview.warnings.map((w) => <li key={w}>{warningLabel(w)}</li>)}</ul>}
              />
            )}

            <Space align="start" size="middle" style={{ width: '100%' }} wrap>
              <div style={{ flex: 1, minWidth: 300 }}><ClientBlock title="Остаётся" client={preview.survivor} /></div>
              <div style={{ flex: 1, minWidth: 300 }}><ClientBlock title="Объединяется" client={preview.merged} /></div>
            </Space>

            <div>
              <Text strong>Что перейдёт</Text>
              <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
                <Descriptions.Item label="Групп">{preview.moves.projects}</Descriptions.Item>
                <Descriptions.Item label="Заказов">
                  {preview.moves.orders}
                  {preview.moves.ordersShown.length > 0 && (
                    <div>
                      {preview.moves.ordersShown.map((order) => (
                        <div key={order.orderId}>
                          <Link to={`/orders/show/${order.orderId}`}>{order.name || `Заказ #${order.orderId}`}</Link>
                          {order.deleted && <Tag style={{ marginInlineStart: 6 }}>в корзине</Tag>}
                        </div>
                      ))}
                      {preview.moves.ordersHidden && <Text type="secondary">+ скрытые заказы</Text>}
                    </div>
                  )}
                  {preview.moves.ordersShown.length === 0 && preview.moves.ordersHidden && <div><Text type="secondary">+ скрытые заказы</Text></div>}
                </Descriptions.Item>
                <Descriptions.Item label="Связь с 1С">{preview.moves.onecLink ? 'перейдёт к остающемуся' : 'нет'}</Descriptions.Item>
                {(preview.moves.bazisCards ?? 0) > 0 && <Descriptions.Item label="Базис-проекты">перейдут к остающемуся: {preview.moves.bazisCards}</Descriptions.Item>}
                <Descriptions.Item label="Телефоны">
                  {preview.phones.moved.length === 0 && preview.phones.dropped.length === 0 && '—'}
                  {preview.phones.moved.map((phone) => (
                    <div key={phone.phoneId}>
                      {phone.number}
                      {phone.phoneId === preview.phones.primaryPhoneId && <Tag color="gold" style={{ marginInlineStart: 6 }}>Основной</Tag>}
                    </div>
                  ))}
                  {preview.phones.dropped.map((phone) => (
                    <div key={phone.phoneId}>
                      <Text delete>{phone.number}</Text> <Text type="secondary">— такой уже есть у остающегося</Text>
                      {phone.phoneId === preview.phones.primaryPhoneId && <Tag color="gold" style={{ marginInlineStart: 6 }}>Основной</Tag>}
                    </div>
                  ))}
                </Descriptions.Item>
                <Descriptions.Item label="Контакты">
                  {preview.contacts.moved.length === 0 && preview.contacts.dropped.length === 0 && '—'}
                  {preview.contacts.moved.map((contact) => <div key={contact.contactId}>{contact.kind}: {contact.value}</div>)}
                  {preview.contacts.dropped.map((contact) => {
                    const line = droppedContactLine(contact);
                    return (
                      <div key={contact.contactId}>
                        <Text delete={line.strike}>{line.text}</Text> <Text type="secondary">{line.note}</Text>
                      </div>
                    );
                  })}
                </Descriptions.Item>
              </Descriptions>
            </div>

            <Text type="secondary">{confirmText(survivorName, mergedName)}</Text>
          </>
        )}
      </Space>
    </Modal>
  );
}
