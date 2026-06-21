import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, Radio, Select, Space, message } from 'antd';
import { cutApi } from '../../../api/cutApi';
import { ApiError } from '../../../api/httpClient';
import type { CutDetailPlacements, CutJobDto } from '../../../api/types/cutApi.types';
import { buildCutAddWarning, formatPlacementsMessage, restrictDetailIds, selectableDetailIds } from '../../cut/cutPageHelpers';

interface AddToCutModalProps {
  open: boolean;
  orderIds: number[];
  /** Detail-level mode: when non-empty, only these chosen details (∩ eligible) are added. */
  detailIds?: number[];
  onClose: () => void;
  onDone?: (job: CutJobDto) => void;
}

/**
 * Orders-list "add to cut" command (plan §9). Backend-owned: it only calls
 * `/api/v1/cut-jobs` (create + eligible-details + items). The operator picks
 * an existing draft job or creates a new one; the selected orders' eligible
 * details are resolved on the backend and reserved.
 */
export const AddToCutModal: React.FC<AddToCutModalProps> = ({ open, orderIds, detailIds, onClose, onDone }) => {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [jobs, setJobs] = useState<CutJobDto[]>([]);
  const [targetJobId, setTargetJobId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [placements, setPlacements] = useState<CutDetailPlacements | null>(null);

  // A provided detailIds array (even empty) means detail-level mode: an empty
  // selection must yield an empty intersection (warning, nothing added) — never
  // a fall-through that adds the whole order's eligible details.
  const detailMode = Array.isArray(detailIds);

  useEffect(() => {
    if (!open) return;
    setName(
      (detailMode
        ? `Раскрой заказ ${orderIds.join(', ')} (детали)`
        : `Раскрой ${orderIds.join(', ')}`
      ).slice(0, 200),
    );
    cutApi
      .list()
      .then((list) => setJobs(list.filter((j) => j.status === 'draft')))
      .catch(() => setJobs([]));
    // Informational only: show where the chosen details already live. Never blocks.
    setPlacements(null);
    cutApi
      .listPlacements(detailMode ? { detailIds: detailIds ?? [] } : { orderIds })
      .then(setPlacements)
      .catch(() => setPlacements(null));
  }, [open, orderIds, detailMode, detailIds]);

  const submit = useCallback(async () => {
    if (orderIds.length === 0) return;
    setBusy(true);
    try {
      const job =
        mode === 'new'
          ? await cutApi.create({ name: name.trim() || 'Раскрой', criteria: { orderIds } })
          : await resolveExistingJob(targetJobId);

      const eligible = await cutApi.listEligibleDetails(job.cutJobId, { orderIds });
      const selectable = selectableDetailIds(eligible.details);
      const finalIds = detailMode ? restrictDetailIds(selectable, detailIds!) : selectable;
      if (finalIds.length === 0) {
        // Don't leave an empty draft behind: a job created above for a brand-new
        // raskroi must be rolled back (archived) when nothing eligible was added.
        // If rollback fails, tell the operator the empty draft remains (no silent orphan).
        const candidates = detailMode
          ? eligible.details.filter((d) => detailIds!.includes(d.orderDetailId))
          : eligible.details;
        let warningText = buildCutAddWarning(candidates);
        if (mode === 'new') {
          try {
            await cutApi.archive(job.cutJobId, job.version);
          } catch {
            warningText += ` Пустой раскрой #${job.cutJobId} не удалён — удалите его вручную.`;
          }
        }
        message.warning(warningText);
        return;
      }
      const updated = await cutApi.addItems(job.cutJobId, { detailIds: finalIds, version: job.version });
      // Count-free: a same-job re-add is a no-op server-side, so we don't claim a
      // precise "added N" that may not reflect newly-inserted rows.
      message.success(`Раскрой #${updated.cutJobId} обновлён`);
      onDone?.(updated);
      onClose();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось добавить в раскрой');
    } finally {
      setBusy(false);
    }
  }, [mode, name, orderIds, detailMode, detailIds, targetJobId, onClose, onDone]);

  return (
    <Modal
      title={detailMode ? `Добавить детали в раскрой (${detailIds!.length})` : `Добавить в раскрой (${orderIds.length} заказ(ов))`}
      open={open}
      onOk={submit}
      confirmLoading={busy}
      onCancel={onClose}
      okText="Добавить"
      cancelText="Отмена"
      okButtonProps={{ disabled: mode === 'existing' && targetJobId === null }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
          <Radio value="new">Новый раскрой</Radio>
          <Radio value="existing" disabled={jobs.length === 0}>
            Существующий черновик
          </Radio>
        </Radio.Group>

        {mode === 'new' ? (
          <Form layout="vertical">
            <Form.Item label="Название раскроя">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Form.Item>
          </Form>
        ) : (
          <Select<number>
            style={{ width: '100%' }}
            placeholder="Выберите черновик раскроя"
            value={targetJobId ?? undefined}
            onChange={setTargetJobId}
            options={jobs.map((j) => ({ value: j.cutJobId, label: `#${j.cutJobId} — ${j.name}` }))}
          />
        )}

        {placements && formatPlacementsMessage(placements) && (
          <Alert type="warning" showIcon message={formatPlacementsMessage(placements)} />
        )}

        <Alert
          type="info"
          showIcon
          message={
            detailMode
              ? 'Будут добавлены только выбранные детали, готовые к раскрою (с раскройной спецификацией материала).'
              : 'Будут добавлены только детали выбранных заказов, готовые к раскрою (с раскройной спецификацией материала).'
          }
        />
      </Space>
    </Modal>
  );
};

async function resolveExistingJob(targetJobId: number | null): Promise<CutJobDto> {
  if (targetJobId === null) {
    throw new ApiError(400, 'NO_JOB_SELECTED', 'Выберите черновик раскроя');
  }
  // Re-fetch for the freshest optimistic version before reserving.
  return cutApi.get(targetJobId);
}
