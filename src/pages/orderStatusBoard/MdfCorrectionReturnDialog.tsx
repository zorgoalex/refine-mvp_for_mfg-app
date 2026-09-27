import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Select, Spin } from "antd";
import { isApiError } from "../../api/apiError";
import {
  mdfCorrectionApi,
  type MdfCorrectionPreviewBody,
  type MdfCorrectionPreviewResponse,
  type MdfCorrectionSourceRef,
} from "../../api/mdfCorrectionApi";
import {
  buildMdfCorrectionReturnViewModel,
} from "./mdfCorrectionReturnViewModel";
import {
  mdfReturnBlockReasonText,
  type MdfReturnSelection,
} from "./mdfReturnSelection";

export interface MdfCorrectionReturnIntent {
  source: MdfCorrectionSourceRef;
  targetColumn: MdfCorrectionPreviewBody["targetColumn"];
  targetTitle: string;
}

/** Never 'legacy' here — the caller routes 'legacy' to MdfProductionReturnDialog instead. */
export type MdfCorrectionReturnDialogSelection = Exclude<
  MdfReturnSelection,
  { kind: "legacy" }
>;

interface Props {
  intent: MdfCorrectionReturnIntent;
  selection: MdfCorrectionReturnDialogSelection;
  onCancel: () => void;
  onReturned: () => Promise<void>;
  /** Blocked/unavailable states resolve by refreshing the whole board, not by
   * re-running just this dialog's own resolution — see OrderStatusBoardPage wiring. */
  onRefreshBoard: () => void;
  /** Re-resolves engine mode + published card: a stale confirm needs a FRESH card token. */
  reselect: () => Promise<MdfReturnSelection>;
  columnTitle: (key: string) => string;
}

export function MdfCorrectionReturnDialog({
  intent,
  selection,
  onCancel,
  onReturned,
  onRefreshBoard,
  reselect,
  columnTitle,
}: Props) {
  if (selection.kind === "blocked") {
    return (
      <Modal
        open
        title={`Вернуть в «${intent.targetTitle}»`}
        onCancel={onCancel}
        closable
        maskClosable
        footer={[
          <Button key="refresh" onClick={onRefreshBoard}>
            Обновить
          </Button>,
          <Button key="cancel" onClick={onCancel}>
            Отмена
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          message={mdfReturnBlockReasonText(selection.reason)}
        />
      </Modal>
    );
  }
  if (selection.kind === "read_only") {
    return (
      <Modal
        open
        title={`Вернуть в «${intent.targetTitle}»`}
        onCancel={onCancel}
        closable
        maskClosable
        footer={[
          <Button key="cancel" onClick={onCancel}>
            Закрыть
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          message="Производственный учёт временно доступен только для чтения. Возврат карточек недоступен."
        />
      </Modal>
    );
  }
  if (selection.kind === "unavailable") {
    return (
      <Modal
        open
        title={`Вернуть в «${intent.targetTitle}»`}
        onCancel={onCancel}
        closable
        maskClosable
        footer={[
          <Button key="refresh" onClick={onRefreshBoard}>
            Обновить
          </Button>,
          <Button key="cancel" onClick={onCancel}>
            Закрыть
          </Button>,
        ]}
      >
        <Alert type="error" showIcon message="Режим учёта недоступен" />
      </Modal>
    );
  }
  return (
    <MdfCorrectionReturnActiveDialog
      intent={intent}
      sourceToken={selection.sourceToken}
      onCancel={onCancel}
      onReturned={onReturned}
      reselect={reselect}
      columnTitle={columnTitle}
    />
  );
}

function MdfCorrectionReturnActiveDialog({
  intent,
  sourceToken: initialSourceToken,
  onCancel,
  onReturned,
  reselect,
  columnTitle,
}: {
  intent: MdfCorrectionReturnIntent;
  sourceToken: string;
  onCancel: () => void;
  onReturned: () => Promise<void>;
  reselect: () => Promise<MdfReturnSelection>;
  columnTitle: (key: string) => string;
}) {
  const [sourceToken, setSourceToken] = useState(initialSourceToken);
  // The exact productionStatusId the current preview was requested with: the backend digest binds the request
  // field, so confirm must repeat it verbatim (never substitute the resolved stage id).
  const previewStatusIdRef = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState<MdfCorrectionPreviewResponse | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown only once a fresh preview after a stale confirm has actually arrived.
  const [notice, setNotice] = useState<string | null>(null);
  const pendingStaleNoticeRef = useRef(false);
  const sequence = useRef(0);
  const savingRef = useRef(false);
  // One key for the whole dialog instance: reused across confirm retries,
  // including the auto re-preview after MDF_CORRECTION_STALE (that failed
  // attempt is never persisted server-side, so replaying the same key is safe).
  const idempotencyKeyRef = useRef<string | null>(null);
  if (idempotencyKeyRef.current === null) {
    idempotencyKeyRef.current = `mdf-correction:${crypto.randomUUID()}`;
  }

  const load = async (productionStatusId?: number) => {
    const seq = ++sequence.current;
    setLoading(true);
    setPreview(null);
    setError(null);
    setNotice(null);
    previewStatusIdRef.current = productionStatusId;
    try {
      const result = await mdfCorrectionApi.preview(intent.source, {
        sourceToken,
        targetColumn: intent.targetColumn,
        productionStatusId,
      });
      if (seq !== sequence.current) return;
      setPreview(result);
      if (pendingStaleNoticeRef.current) {
        pendingStaleNoticeRef.current = false;
        setNotice("Последствия возврата изменились. Предпросмотр обновлён — подтвердите ещё раз.");
      }
    } catch (e) {
      if (seq === sequence.current) {
        setError(
          e instanceof Error
            ? e.message
            : "Не удалось рассчитать последствия возврата"
        );
      }
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load(previewStatusIdRef.current);
    return () => {
      sequence.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.source.kind, intent.source.id, intent.targetColumn, sourceToken]);

  const confirm = async () => {
    if (!preview || preview.status !== "ready" || !preview.digest) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await mdfCorrectionApi.confirm(intent.source, {
        sourceToken,
        targetColumn: intent.targetColumn,
        ...(previewStatusIdRef.current !== undefined ? { productionStatusId: previewStatusIdRef.current } : {}),
        expectedDigest: preview.digest,
        idempotencyKey: idempotencyKeyRef.current!,
      });
    } catch (e) {
      if (isApiError(e, "MDF_CORRECTION_STALE")) {
        // Keep the synchronous confirm guard until the recovery has replaced (or cleared) the rejected preview.
        setSaving(false);
        pendingStaleNoticeRef.current = true;
        void refresh(previewStatusIdRef.current).finally(() => { savingRef.current = false; });
        return;
      }
      setError(
        e instanceof Error ? e.message : "Не удалось подтвердить возврат"
      );
      savingRef.current = false;
      setSaving(false);
      return;
    }
    savingRef.current = false;
    setSaving(false);
    await onReturned();
  };

  /** Re-resolve the card (fresh token when it changed) and re-preview; a card that is no longer ready shows why. */
  const refresh = async (productionStatusId?: number) => {
    // Invalidate first (confirm disabled while loading, no stale preview); the whole reselect → preview operation is
    // sequence-guarded so an overlapping/older refresh can never apply its result.
    const seq = ++sequence.current;
    setPreview(null);
    setLoading(true);
    setError(null);
    setNotice(null);
    let next: MdfReturnSelection;
    try { next = await reselect(); } catch { next = { kind: "unavailable" }; }
    if (seq !== sequence.current) return;
    if (next.kind !== "new") {
      pendingStaleNoticeRef.current = false;
      setLoading(false);
      setError(next.kind === "blocked" ? mdfReturnBlockReasonText(next.reason)
        : next.kind === "read_only" ? "Производственный учёт сейчас доступен только для чтения."
          : "Режим учёта недоступен — обновите доску.");
      return;
    }
    if (next.sourceToken !== sourceToken) {
      previewStatusIdRef.current = productionStatusId;
      setSourceToken(next.sourceToken); // the token effect re-runs the preview (a newer sequence)
      return;
    }
    await load(productionStatusId);
  };

  const vm = preview ? buildMdfCorrectionReturnViewModel(preview, columnTitle) : null;
  const confirmDisabled = loading || saving || !preview || preview.status !== "ready";

  return (
    <Modal
      open
      title={`Вернуть в «${intent.targetTitle}»`}
      width={640}
      onCancel={saving ? undefined : onCancel}
      closable={!saving}
      maskClosable={!saving}
      onOk={() => void confirm()}
      okText="Подтвердить возврат"
      cancelText="Отмена"
      confirmLoading={saving}
      okButtonProps={{ disabled: confirmDisabled }}
      cancelButtonProps={{ disabled: saving }}
    >
      <div
        style={{
          maxHeight: "65vh",
          overflowY: "auto",
          overflowWrap: "anywhere",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {notice && <Alert type="warning" showIcon message={notice} style={{ marginBottom: 12 }} />}
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            action={
              <Button
                disabled={saving}
                onClick={() => void refresh(previewStatusIdRef.current)}
              >
                Обновить предпросмотр
              </Button>
            }
          />
        )}
        {loading && (
          <div style={{ padding: 24, textAlign: "center" }}>
            <Spin aria-label="Расчёт последствий возврата" />
          </div>
        )}
        {vm && preview && (
          <>
            <p>
              {vm.sourceLabel}. Целевая колонка: {vm.targetColumnTitle}.
              Изменится деталей-позиций: {vm.details.length}.
            </p>
            {preview.stages.length > 0 && (
              <>
                <label htmlFor="mdf-correction-stage">
                  В какой производственный статус перевести детали карточки?
                </label>
                <Select
                  id="mdf-correction-stage"
                  aria-label="Производственный статус деталей"
                  value={preview.targetStage.id}
                  options={preview.stages.map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                  disabled={saving}
                  style={{ width: "100%", marginTop: 4, marginBottom: 12 }}
                  onChange={(id) => void load(id)}
                />
              </>
            )}
            {preview.status === "blocked" && (
              <Alert
                type="error"
                showIcon
                message="Возврат заблокирован"
                description={
                  <ul>
                    {vm.blockerTexts.map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {vm.orderConsequences.length ? (
              <Alert
                type="warning"
                showIcon
                message="По правилам автостатусов изменится статус заказа"
                description={
                  <ul>
                    {vm.orderConsequences.map((o) => (
                      <li key={o.orderId}>{o.text}</li>
                    ))}
                  </ul>
                }
              />
            ) : (
              <p>
                Статусы заказов не изменятся: доска сама их не меняет,
                подходящих правил автостатусов нет.
              </p>
            )}
            {vm.detailsByOrder.length > 0 && (
              <details open={vm.details.length <= 8} style={{ marginTop: 12 }}>
                <summary>Детали ({vm.details.length})</summary>
                {vm.detailsByOrder.map((bucket) => (
                  <div key={bucket.orderId}>
                    <strong>{bucket.orderName}</strong>
                    <ul>
                      {bucket.rows.map((row) => (
                        <li key={row.key}>
                          поз. {row.detailNumber ?? row.detailId}:{" "}
                          {row.beforeStatus ?? "Без статуса"} →{" "}
                          {row.afterStatus ?? "Без статуса"}
                          {row.statusKept
                            ? " (статус сохранён по остальным доказательствам)"
                            : ""}
                          . {row.wholeQuantity} шт.
                          {row.cardQuantity < row.wholeQuantity
                            ? ` (в карточке ${row.cardQuantity} шт.)`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            )}
            {vm.baths.length > 0 && (
              <details open style={{ marginTop: 12 }}>
                <summary>Связанные ванны ({vm.baths.length})</summary>
                <ul>
                  {vm.baths.map((bath) => (
                    <li key={bath.key}>
                      Ванна {bath.bathId}: {bath.beforeColumnTitle} →{" "}
                      {bath.pendingRecalculation
                        ? "станет известно после пересчёта"
                        : bath.afterColumnTitle ?? "—"}
                      .
                      {bath.cancelledLaminationQuantity > 0
                        ? ` Отменяется облицовка: ${bath.cancelledLaminationQuantity} шт.`
                        : ""}
                      {bath.clearsManualPlacementOverride
                        ? " Ручное размещение будет снято."
                        : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {vm.warnings.map((w) => (
              <p key={w} style={{ fontSize: 12 }}>
                {w}
              </p>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
