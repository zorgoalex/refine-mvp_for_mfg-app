import { createHash } from "node:crypto";
import { ApiError } from "../../../common/errors/api-error";
import { auditService } from "../../../common/audit/audit.service";
import type { DatabaseService } from "../../../database/database.service";
import type { TransactionClient } from "../../../database/database.types";
import type { CurrentUser } from "../../../permissions/current-user";
import { OrderAccessPolicy } from "../../../permissions/policies/order-access.policy";
import {
  allowsScope,
  rolePolicyForUser,
} from "../../../permissions/policies/scope";
import {
  correctionDetailIds,
  returnStageOptions,
  type MdfReturnKind,
  type MdfReturnStage,
} from "../domain/mdf-production-return";
import type {
  MdfReturnConfirmRequest,
  MdfReturnPreview,
  MdfReturnRequest,
  MdfReturnResult,
} from "../dto/mdf-production-return.dto";
import {
  loadReturnSnapshot,
  returnSourceOwners,
  type ReturnOrder,
  type ReturnSnapshot,
} from "./mdf-return-snapshot";

type Source = { kind: MdfReturnKind; id: string };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string, message: string, status = 422): never {
  throw new ApiError(status, code, message);
}
const norm = (name: string | null) =>
  (name ?? "").trim().toLowerCase().replace(/ё/g, "е");

export class PgMdfProductionReturn {
  constructor(
    private readonly database: Pick<DatabaseService, "transaction">
  ) {}

  preview(
    user: CurrentUser,
    source: Source,
    request: MdfReturnRequest
  ): Promise<MdfReturnPreview> {
    return this.transaction(
      user,
      source,
      request.boardWindow,
      async (tx, before, owners) => {
        const prepared = await this.prepare(
          tx,
          user,
          source,
          request,
          before,
          owners
        );
        return prepared.preview;
      }
    );
  }

  confirm(
    user: CurrentUser,
    source: Source,
    request: MdfReturnConfirmRequest,
    requestId: string
  ): Promise<MdfReturnResult> {
    return this.transaction(
      user,
      source,
      request.boardWindow,
      async (tx, before, owners) => {
        const requestHash = hash({ source, request, actor: user.id });
        const inserted = await tx.query(
          `INSERT INTO command_idempotency_keys
        (idempotency_key,command_name,actor_user_id,entity_type,entity_id,request_hash,status)
        VALUES ($1,'mdf_board.production_return',$2,'mdf_board_card',$3,$4,'processing')
        ON CONFLICT DO NOTHING RETURNING idempotency_key`,
          [
            request.idempotencyKey,
            Number(user.id),
            `${source.kind}:${source.id}`,
            requestHash,
          ]
        );
        if (!inserted.rows.length) {
          const receipt = await tx.query<{
            request_hash: string;
            status: string;
            response_json: MdfReturnResult;
          }>(
            "SELECT request_hash,status,response_json FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE NOWAIT",
            [request.idempotencyKey]
          );
          const r = receipt.rows[0];
          if (!r || r.request_hash !== requestHash)
            fail(
              "IDEMPOTENCY_KEY_REUSED",
              "Ключ подтверждения уже использован",
              409
            );
          if (r.status !== "completed" || !r.response_json)
            fail(
              "IDEMPOTENCY_IN_PROGRESS",
              "Подтверждение ещё выполняется",
              409
            );
          return r.response_json;
        }
        const prepared = await this.prepare(
          tx,
          user,
          source,
          request,
          before,
          owners
        );
        if (prepared.preview.digest !== request.expectedDigest)
          fail(
            "MDF_RETURN_STALE",
            "Данные изменились. Обновите предпросмотр возврата.",
            409
          );
        await applyReturnFacts(
          tx,
          user,
          source,
          prepared.preview,
          prepared.reopenStatusId
        );
        const after = await loadReturnSnapshot(
          tx,
          source,
          owners,
          request.boardWindow
        );
        if (hash(after.cards) !== prepared.cardsDigest)
          fail(
            "MDF_RETURN_STALE",
            "Последствия возврата изменились. Обновите предпросмотр.",
            409
          );
        const p = prepared.preview;
        const auditId = await auditService.record(tx, {
          event: "mdf_board.production_returned",
          entityType: "mdf_board_card",
          entityId: `${source.kind}:${source.id}`,
          actorUserId: user.id,
          actorUsername: user.username,
          actorRole: user.role,
          requestId,
          source: "backend-mdf-production-return",
          statusField: "production_status_id",
          statusId: p.targetStage.id,
          statusName: p.targetStage.name,
          statusCode: p.targetColumn,
          relatedOrderId: owners.length === 1 ? owners[0] : null,
          relatedEntities: [
            ...owners.map((id) => ({ entityType: "order", entityId: id })),
            ...p.details.map((d) => ({
              entityType: "order_detail",
              entityId: d.detailId,
            })),
          ],
          before: {
            details: p.details.map((d) => ({
              detailId: d.detailId,
              status: d.before,
            })),
            orders: p.orders.map((o) => ({
              orderId: o.orderId,
              status: o.before,
            })),
            sourceFact: before.sourceFact,
          },
          after: {
            details: p.details.map((d) => ({
              detailId: d.detailId,
              status: d.after,
            })),
            orders: p.orders.map((o) => ({
              orderId: o.orderId,
              status: o.after,
            })),
            sourceFact: after.sourceFact,
          },
          diff: { cards: p.cards },
          metadata: {
            idempotencyKey: request.idempotencyKey,
            scope: source,
            previewDigest: p.digest,
            changedDetailIds: p.details.map((d) => d.detailId),
            orderIds: owners,
            completionBarrier: p.resetsCompletion,
          },
        });
        const result: MdfReturnResult = { preview: p, auditId, requestId };
        await tx.query(
          `INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
        VALUES ('mdf_board.production_returned','mdf_board_card',$1,$2::jsonb,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            `${source.kind}:${source.id}`,
            JSON.stringify({
              actorUserId: user.id,
              requestId,
              source,
              orderIds: owners,
              detailIds: p.details.map((d) => d.detailId),
              auditId,
            }),
            `${request.idempotencyKey}:returned`,
          ]
        );
        await tx.query(
          `UPDATE command_idempotency_keys SET status='completed',response_json=$2::jsonb,completed_at=now()
        WHERE idempotency_key=$1`,
          [request.idempotencyKey, JSON.stringify(result)]
        );
        return result;
      }
    );
  }

  private async transaction<T>(
    user: CurrentUser,
    source: Source,
    boardWindow: MdfReturnRequest["boardWindow"],
    run: (
      tx: TransactionClient,
      before: ReturnSnapshot,
      owners: number[]
    ) => Promise<T>
  ): Promise<T> {
    for (const p of [
      "orders.view",
      "production.tasks.update",
      "orders.change_production_status",
    ] as const) {
      if (!user.permissions.includes(p))
        fail(
          "PERMISSION_DENIED",
          "Недостаточно прав для возврата производственного этапа",
          403
        );
    }
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        await tx.query("SET LOCAL jit=off");
        await tx.query("SELECT set_session_user($1)", [user.id]);
        const owners = await returnSourceOwners(tx, source.kind, source.id);
        await tx.query(
          "SELECT order_id FROM orders WHERE order_id=ANY($1::bigint[]) ORDER BY order_id FOR UPDATE",
          [owners]
        );
        await tx.query(
          "SELECT detail_id FROM order_details WHERE order_id=ANY($1::bigint[]) ORDER BY detail_id FOR UPDATE",
          [owners]
        );
        if (source.kind === "packet")
          await tx.query(
            "SELECT packet_id FROM cnc_telegram_packets WHERE packet_id::text=$1 FOR UPDATE NOWAIT",
            [source.id]
          );
        await tx.query(
          "SELECT move_id FROM mdf_board_manual_moves WHERE card_kind=$1 AND card_id=$2 FOR UPDATE NOWAIT",
          [source.kind, source.id]
        );
        if (
          hash(await returnSourceOwners(tx, source.kind, source.id)) !==
          hash(owners)
        )
          fail("MDF_RETURN_STALE", "Состав карточки изменился", 409);
        const before = await loadReturnSnapshot(
          tx,
          source,
          owners,
          boardWindow
        );
        assertAccess(user, before.orders, owners);
        return run(tx, before, owners);
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["40001", "40P01", "55P03"].includes(String(error.code))
      ) {
        fail(
          "MDF_RETURN_STALE",
          "Карточка сейчас изменяется. Обновите предпросмотр возврата.",
          409
        );
      }
      throw error;
    }
  }

  private async prepare(
    tx: TransactionClient,
    user: CurrentUser,
    source: Source,
    request: MdfReturnRequest,
    before: ReturnSnapshot,
    owners: number[]
  ) {
    const card = before.cards.find(
      (c) => c.kind === source.kind && c.id === source.id
    );
    if (!card || !card.members.length)
      fail(
        "MDF_RETURN_SOURCE_UNAVAILABLE",
        "Карточка не найдена среди действующих производственных данных"
      );
    const sequence =
      source.kind === "bath"
        ? ["baths", "baths_ready", "baths_laminated", "completed_baths"]
        : ["parsed", "completed", "completed_laminated"];
    if (
      sequence.indexOf(request.targetColumn) < 0 ||
      sequence.indexOf(request.targetColumn) >= sequence.indexOf(card.column)
    ) {
      fail(
        "MDF_RETURN_NOT_BACKWARD",
        "Выберите предыдущую производственную колонку"
      );
    }
    const detailMap = new Map(before.details.map((d) => [d.id, d]));
    const quantities = new Map<number, number>();
    for (const m of card.members) {
      const d = m.detailId ? detailMap.get(m.detailId) : undefined;
      if (
        !d ||
        d.deleted ||
        d.orderId !== m.orderId ||
        !owners.includes(d.orderId)
      ) {
        fail(
          "MDF_RETURN_UNRESOLVED",
          "Есть несопоставленные или удалённые позиции. Сначала исправьте состав карточки."
        );
      }
      quantities.set(d.id, (quantities.get(d.id) ?? 0) + m.quantity);
    }
    const stagesResult =
      await tx.query<MdfReturnStage>(`SELECT production_status_id::integer AS id,
      production_status_code AS code,production_status_name AS name,sort_order AS rank FROM production_statuses
      WHERE is_active=true AND sort_order IS NOT NULL ORDER BY sort_order,production_status_id`);
    const stages = returnStageOptions(
      source.kind,
      request.targetColumn,
      stagesResult.rows
    );
    const defaultCode =
      request.targetColumn === "parsed"
        ? "drawn"
        : request.targetColumn === "baths_ready"
        ? "sanded"
        : request.targetColumn === "baths_laminated"
        ? "laminated"
        : "cut";
    const target = request.productionStatusId
      ? stages.find((s) => s.id === request.productionStatusId)
      : stages.find((s) => s.code === defaultCode) ?? stages[0];
    if (!target)
      fail(
        "MDF_RETURN_STAGE_UNAVAILABLE",
        "Подходящий производственный этап не найден в справочнике"
      );
    const sourceOrders = before.orders.filter((o) => owners.includes(o.id));
    for (const o of sourceOrders) {
      if (
        o.deleted ||
        o.kind !== "production_order" ||
        ["завершен", "завершено"].includes(norm(o.status))
      ) {
        fail(
          "MDF_RETURN_ORDER_CLOSED",
          "Сначала отдельно откройте завершённый заказ. Возврат карточки не открывает его автоматически."
        );
      }
    }
    const reopen = sourceOrders.filter((o) =>
      ["готов к выдаче", "выдан"].includes(norm(o.status))
    );
    let reopenStatusId: number | null = null;
    if (reopen.length) {
      if (
        !user.permissions.includes("orders.change_status") ||
        reopen.some((o) => !new OrderAccessPolicy().canUpdate(user, subject(o)))
      ) {
        fail(
          "PERMISSION_DENIED",
          "Для возврата нужно право изменения статуса всех затронутых заказов",
          403
        );
      }
      // Packer permission is intentionally restricted to ready/issued, never reopening.
      if (
        user.role === "packer" ||
        rolePolicyForUser(user).orders.update === "none"
      )
        fail("PERMISSION_DENIED", "Недостаточно прав для открытия заказа", 403);
      const status = await tx.query<{
        id: number;
      }>(`SELECT order_status_id::integer AS id FROM order_statuses
        WHERE is_active=true AND lower(trim(order_status_name))='в производстве'`);
      if (status.rows.length !== 1)
        fail(
          "MDF_RETURN_ORDER_STATUS_UNAVAILABLE",
          "Статус заказа «В производстве» не найден или неоднозначен"
        );
      reopenStatusId = status.rows[0].id;
    }
    const changed = new Set(
      correctionDetailIds(
        before.details.filter((d) => quantities.has(d.id)),
        target.rank
      )
    );
    const preview: MdfReturnPreview = {
      source: { ...source, label: card.label },
      targetColumn: request.targetColumn,
      targetStage: target,
      stages,
      digest: "",
      details: before.details
        .filter((d) => changed.has(d.id))
        .map((d) => ({
          detailId: d.id,
          orderId: d.orderId,
          orderName: sourceOrders.find((o) => o.id === d.orderId)!.name,
          detailNumber: d.number,
          quantity: d.quantity,
          cardQuantity: quantities.get(d.id)!,
          before: d.status,
          after: target.name,
        })),
      orders: sourceOrders.map((o) => ({
        orderId: o.id,
        orderName: o.name,
        before: o.status,
        after: reopen.includes(o) ? "В производстве" : o.status,
      })),
      cards: [],
      resetsCompletion:
        source.kind === "packet" && request.targetColumn === "parsed",
      warnings: [],
    };
    if (card.wholeOrderIds?.length)
      preview.warnings.push(
        "В файле есть отметка «весь заказ». Возврат затронет все обычные позиции указанных заказов, включая отсутствующие в списке файла. ХДФ исключён."
      );
    if (preview.details.some((d) => d.cardQuantity < d.quantity))
      preview.warnings.push(
        "Статус позиции общий для всего количества заказа. Для позиций, частично входящих в карточку, изменится статус всего указанного количества."
      );
    if (preview.details.length < quantities.size)
      preview.warnings.push(
        "Детали без статуса и на более раннем этапе останутся без изменений."
      );
    if (preview.resetsCompletion)
      preview.warnings.push(
        "Ошибочная отметка выполнения файла будет снята. Повтор старой отметки не завершит файл снова: требуется снять её в источнике и поставить заново либо явно продвинуть карточку."
      );
    preview.digest = hash({
      actor: {
        id: user.id,
        permissions: user.permissions,
        scopes: rolePolicyForUser(user),
      },
      source,
      target: target.id,
      column: request.targetColumn,
      boardWindow: request.boardWindow,
      before,
      stages: stagesResult.rows,
      reopenStatusId,
    });
    await tx.query("SAVEPOINT mdf_return_preview");
    let after: ReturnSnapshot;
    try {
      await applyReturnFacts(tx, user, source, preview, reopenStatusId);
      after = await loadReturnSnapshot(tx, source, owners, request.boardWindow);
    } finally {
      await tx.query("ROLLBACK TO SAVEPOINT mdf_return_preview");
      await tx.query("RELEASE SAVEPOINT mdf_return_preview");
    }
    const afterCard = after.cards.find(
      (c) => c.kind === source.kind && c.id === source.id
    );
    if (!afterCard || afterCard.column !== request.targetColumn)
      fail(
        "MDF_RETURN_DESTINATION_BLOCKED",
        "Действующие правила не позволяют вернуть карточку в эту колонку. Проверьте статусы связанных заказов."
      );
    preview.cards = before.cards.flatMap((c) => {
      const a = after.cards.find((a) => a.kind === c.kind && a.id === c.id);
      return a && a.column !== c.column
        ? [
            {
              kind: c.kind,
              id: c.id,
              label: c.label,
              before: c.column,
              after: a.column,
            },
          ]
        : [];
    });
    return { preview, reopenStatusId, cardsDigest: hash(after.cards) };
  }
}

function subject(o: ReturnOrder) {
  return {
    orderId: o.id,
    createdByUserId: o.createdBy,
    managerUserId: o.managerId,
    assignedUserIds: o.assigned,
  };
}
function assertAccess(
  user: CurrentUser,
  orders: ReturnOrder[],
  owners: number[]
) {
  const policy = new OrderAccessPolicy();
  for (const o of orders) {
    if (!policy.canView(user, subject(o)))
      fail("PERMISSION_DENIED", "Нет доступа ко всем связанным заказам", 403);
    if (
      owners.includes(o.id) &&
      !policy.canUpdate(user, subject(o)) &&
      !(
        rolePolicyForUser(user).productionTasks.update === "assigned" &&
        allowsScope(user, "assigned", subject(o))
      )
    ) {
      fail(
        "PERMISSION_DENIED",
        "Нет доступа к изменению деталей этого заказа",
        403
      );
    }
  }
  if (owners.some((id) => !orders.some((o) => o.id === id)))
    fail("MDF_RETURN_UNRESOLVED", "Заказ карточки не найден");
}

async function applyReturnFacts(
  tx: TransactionClient,
  user: CurrentUser,
  source: Source,
  p: MdfReturnPreview,
  reopenStatusId: number | null
) {
  if (p.details.length)
    await tx.query(
      "UPDATE order_details SET production_status_id=$1 WHERE detail_id=ANY($2::bigint[])",
      [p.targetStage.id, p.details.map((d) => d.detailId)]
    );
  for (const o of p.orders) {
    if (o.before === o.after && !p.details.some((d) => d.orderId === o.orderId))
      continue;
    await tx.query(
      `UPDATE orders SET order_status_id=CASE WHEN $2::bigint IS NULL THEN order_status_id ELSE $2 END,
      version=version+1,updated_at=now(),edited_by=$3 WHERE order_id=$1`,
      [o.orderId, o.before !== o.after ? reopenStatusId : null, Number(user.id)]
    );
    if (p.details.some(d=>d.orderId===o.orderId))
      await tx.query("SELECT recalc_order_production_status($1)", [o.orderId]);
  }
  if (p.resetsCompletion)
    await tx.query(
      `UPDATE cnc_telegram_packets SET completion_status='pending',thumbs_up=false,
    completed_at=NULL,mdf_completion_returned=true,updated_at=now(),updated_by=$2 WHERE packet_id::text=$1`,
      [source.id, Number(user.id)]
    );
  await tx.query(
    `INSERT INTO mdf_board_manual_moves(card_kind,card_id,target_column,created_by_user_id,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$4) ON CONFLICT (card_kind,card_id) DO UPDATE SET target_column=EXCLUDED.target_column,
    updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now(),version=mdf_board_manual_moves.version+1`,
    [source.kind, source.id, p.targetColumn, Number(user.id)]
  );
}
