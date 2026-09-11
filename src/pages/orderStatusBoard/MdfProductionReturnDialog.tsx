import React, { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Select, Spin } from "antd";
import {
  mdfProductionReturnApi,
  type MdfReturnPreview,
  type MdfReturnRequest,
  type MdfReturnSource,
} from "../../api/mdfProductionReturnApi";

export interface MdfReturnIntent {
  source: MdfReturnSource;
  targetColumn: MdfReturnRequest["targetColumn"];
  targetTitle: string;
  boardWindow?: MdfReturnRequest["boardWindow"];
}
interface Props {
  intent: MdfReturnIntent;
  onCancel: () => void;
  onReturned: () => Promise<void>;
  columnTitle: (key: string) => string;
}

export function MdfProductionReturnDialog({
  intent,
  onCancel,
  onReturned,
  columnTitle,
}: Props) {
  const [preview, setPreview] = useState<MdfReturnPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const key = useRef("");
  const savingRef = useRef(false);
  const load = async (productionStatusId?: number) => {
    const seq = ++sequence.current;
    setLoading(true);
    setPreview(null);
    setError(null);
    try {
      const result = await mdfProductionReturnApi.preview(intent.source, {
        targetColumn: intent.targetColumn,
        productionStatusId,
        boardWindow: intent.boardWindow,
      });
      if (seq !== sequence.current) return;
      key.current = `mdf-return:${crypto.randomUUID()}`;
      setPreview(result);
    } catch (e) {
      if (seq === sequence.current)
        setError(
          e instanceof Error
            ? e.message
            : "Не удалось рассчитать последствия возврата"
        );
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [intent]);
  const confirm = async () => {
    if (!preview || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await mdfProductionReturnApi.confirm(intent.source, {
        targetColumn: intent.targetColumn,
        productionStatusId: preview.targetStage.id,
        boardWindow: intent.boardWindow,
        expectedDigest: preview.digest,
        idempotencyKey: key.current,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось подтвердить возврат"
      );
      if (e && typeof e === "object" && "status" in e && e.status === 409)
        setPreview(null);
      savingRef.current = false;
      setSaving(false);
      return;
    }
    savingRef.current = false;
    setSaving(false);
    await onReturned();
  };
  const orderChanges =
    preview?.orders.filter((o) => o.before !== o.after) ?? [];
  return (
    <Modal
      open
      title={`Вернуть в «${intent.targetTitle}»`}
      width={620}
      onCancel={saving ? undefined : onCancel}
      closable={!saving}
      maskClosable={!saving}
      onOk={() => void confirm()}
      okText="Подтвердить возврат"
      cancelText="Отмена"
      confirmLoading={saving}
      okButtonProps={{ disabled: loading || !preview || saving }}
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
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            action={
              <Button
                disabled={saving}
                onClick={() => void load(preview?.targetStage.id)}
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
        {preview && (
          <>
            <p>
              {preview.source.label}. Изменится деталей-позиций:{" "}
              {preview.details.length}.
            </p>
            <label htmlFor="mdf-return-stage">Вернуть детали на этап</label>
            <Select
              id="mdf-return-stage"
              aria-label="Этап возврата деталей"
              value={preview.targetStage.id}
              options={preview.stages.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              disabled={saving}
              style={{ width: "100%", marginTop: 4, marginBottom: 12 }}
              onChange={(id) => void load(id)}
            />
            {orderChanges.length ? (
              <Alert
                type="warning"
                showIcon
                message="Статус заказа тоже изменится"
                description={
                  <ul>
                    {orderChanges.map((o) => (
                      <li key={o.orderId}>
                        {o.orderName}: {o.before} → {o.after}
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : (
              <p>Статусы заказов не изменятся.</p>
            )}
            <details
              open={preview.details.length <= 8}
              style={{ marginTop: 12 }}
            >
              <summary>Детали ({preview.details.length})</summary>
              <ul>
                {preview.details.map((d) => (
                  <li key={d.detailId}>
                    {d.orderName}, поз. {d.detailNumber ?? d.detailId}:{" "}
                    {d.before ?? "Без статуса"} → {d.after}. {d.quantity} шт.
                    {d.cardQuantity < d.quantity
                      ? ` (в карточке ${d.cardQuantity} шт.)`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
            <details open style={{ marginTop: 12 }}>
              <summary>Перемещения карточек ({preview.cards.length})</summary>
              <ul>
                {preview.cards.map((c) => (
                  <li key={`${c.kind}:${c.id}`}>
                    {c.label}: {columnTitle(c.before)} → {columnTitle(c.after)}
                  </li>
                ))}
              </ul>
            </details>
            {preview.warnings.map((w) => (
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

export function isMdfBackwardMove(
  kind: string,
  from: string | undefined,
  to: string
): boolean {
  const columns =
    kind === "bath"
      ? ["baths", "baths_ready", "baths_laminated", "completed_baths"]
      : kind === "packet" || kind === "bazisCutSet"
      ? ["parsed", "completed", "completed_laminated"]
      : [];
  return (
    from !== undefined &&
    columns.indexOf(to) >= 0 &&
    columns.indexOf(to) < columns.indexOf(from)
  );
}
