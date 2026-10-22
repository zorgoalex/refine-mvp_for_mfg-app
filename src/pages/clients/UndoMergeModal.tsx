import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Spin, Typography } from 'antd';
import { isApiError } from '../../api/apiError';
import { clientMergesApi } from '../../api/clientMergesApi';
import type { MergeObstacle, MergeUndoReport, MergeView, UndoPreview } from '../../api/clientMergesApiTypes';
import { mergeErrorInfo, newIdempotencyKey, obstaclesFromDetails } from '../integrations/mergeClientsModel';
import { canConfirmUndo, mergeDirectionText, returnedLines, skippedLine } from './clientMergesModel';

const { Text } = Typography;

export interface UndoMergeModalProps {
  merge: MergeView | null;
  onClose: () => void;
  /** Reload the client card/history (after undo, or when the state turned out different). */
  onChanged: () => void;
}

function Report({ report }: { report: MergeUndoReport }) {
  const returned = returnedLines(report.returned);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="success" showIcon message="Объединение отменено" />
      <div>
        <Text strong>Возвращено</Text>
        {returned.length ? (
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
            {returned.map((line) => <li key={line.key}>{line.label}: {line.value}</li>)}
          </ul>
        ) : <div><Text type="secondary">ничего</Text></div>}
      </div>
      {report.skipped.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Не возвращено"
          description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{report.skipped.map((item, i) => <li key={i}>{skippedLine(item)}</li>)}</ul>}
        />
      )}
    </Space>
  );
}

export function UndoMergeModal({ merge, onClose, onChanged }: UndoMergeModalProps) {
  const mergeId = merge?.mergeId ?? null;
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraObstacles, setExtraObstacles] = useState<MergeObstacle[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<MergeUndoReport | null>(null);
  const idempotencyKey = useRef<string>(newIdempotencyKey());
  const generation = useRef(0);

  const runPreview = useCallback(async () => {
    if (mergeId == null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    setExtraObstacles([]);
    try {
      const result = await clientMergesApi.undoPreview(mergeId);
      if (mine !== generation.current) return;
      setPreview(result);
      idempotencyKey.current = newIdempotencyKey();
    } catch (err) {
      if (mine !== generation.current) return;
      setPreview(null);
      setError(isApiError(err) ? mergeErrorInfo(err.code, err.message).message : 'Не удалось получить предварительный расчёт');
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [mergeId]);

  useEffect(() => {
    generation.current += 1;
    setPreview(null);
    setReport(null);
    setError(null);
    setNotice(null);
    setExtraObstacles([]);
    if (mergeId != null) void runPreview();
  }, [mergeId, runPreview]);

  const obstacles = [...(preview?.obstacles ?? []), ...extraObstacles];
  const enabled = canConfirmUndo(preview ? { obstacles, previewToken: preview.previewToken } : null, loading || saving);

  const confirm = () => {
    if (!preview || !enabled) return;
    Modal.confirm({
      title: 'Отменить объединение?',
      content: 'Заказы, телефоны и контакты, которые не менялись после объединения, вернутся прежнему клиенту.',
      okText: 'Отменить объединение',
      okButtonProps: { danger: true },
      cancelText: 'Назад',
      onOk: () => submit(preview),
    });
  };

  const submit = async (current: UndoPreview) => {
    if (mergeId == null || !current.previewToken) return;
    setSaving(true);
    try {
      const result = await clientMergesApi.undo(mergeId, {
        previewToken: current.previewToken,
        idempotencyKey: idempotencyKey.current,
      });
      setReport(result.report);
      onChanged();
    } catch (err) {
      if (!isApiError(err)) {
        setError('Не удалось отменить объединение');
        return;
      }
      const info = mergeErrorInfo(err.code, err.message);
      if (err.code === 'CLIENT_MERGE_UNDO_BLOCKED') {
        setExtraObstacles(obstaclesFromDetails(err.details));
        setNotice(info.message);
      } else if (info.action === 'refresh_preview') {
        setNotice(info.message);
        void runPreview();
      } else if (info.action === 'reload_case') {
        setError(info.message);
        onChanged();
      } else {
        setError(info.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={merge != null}
      title="Отмена объединения"
      width={640}
      onCancel={onClose}
      destroyOnClose
      footer={report ? <Button type="primary" onClick={onClose}>Закрыть</Button> : (
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button type="primary" danger disabled={!enabled} loading={saving} onClick={confirm}>Отменить объединение</Button>
        </Space>
      )}
    >
      {merge && <Text>{mergeDirectionText(merge)}</Text>}
      <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 12 }}>
        {loading && <Spin />}
        {notice && <Alert type="info" showIcon message={notice} />}
        {error && <Alert type="error" showIcon message={error} />}
        {report && <Report report={report} />}
        {!report && preview && (
          <>
            {obstacles.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="Отменить сейчас нельзя"
                description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{obstacles.map((o, i) => <li key={`${o.code}:${i}`}>{o.message}</li>)}</ul>}
              />
            )}
            <Descriptions size="small" column={1} bordered title="Что вернётся">
              <Descriptions.Item label="Групп">{preview.returns.projects}</Descriptions.Item>
              <Descriptions.Item label="Заказов">{preview.returns.orders}</Descriptions.Item>
              <Descriptions.Item label="Телефонов">{preview.returns.phones}</Descriptions.Item>
              <Descriptions.Item label="Контактов">{preview.returns.contacts}</Descriptions.Item>
              <Descriptions.Item label="Связь с 1С">{preview.returns.onecLink ? 'вернётся' : 'нет'}</Descriptions.Item>
            </Descriptions>
            {preview.skipped.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Не вернётся"
                description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{preview.skipped.map((item, i) => <li key={i}>{skippedLine(item)}</li>)}</ul>}
              />
            )}
          </>
        )}
      </Space>
    </Modal>
  );
}
