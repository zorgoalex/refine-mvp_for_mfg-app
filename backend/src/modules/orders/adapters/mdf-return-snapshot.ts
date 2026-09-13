import type { DatabaseClient } from "../../../database/database.types";
import { ApiError } from "../../../common/errors/api-error";
import { loadMdfReturnSources } from "../../cnc-telegram/adapters/pg-cnc-telegram-repository";
import type { CncTelegramTodayColumnDto } from "../../cnc-telegram/dto/cnc-telegram.dto";
import {
  resolveMdfProductionColumn,
  type MdfReturnKind,
} from "../domain/mdf-production-return";

export interface ReturnMember {
  detailId: number | null;
  orderId: number | null;
  quantity: number;
}
export interface ReturnCard {
  kind: MdfReturnKind;
  id: string;
  label: string;
  column: string;
  members: ReturnMember[];
  wholeOrderIds?: number[];
}
export interface ReturnOrder {
  id: number;
  name: string;
  statusId: number | null;
  status: string | null;
  version: number;
  createdBy: string | null;
  managerId: string | null;
  assigned: string[];
  deleted: boolean;
  kind: string;
  issuedOrLater: boolean;
}
export interface ReturnDetail {
  id: number;
  orderId: number;
  number: number | null;
  quantity: number;
  statusId: number | null;
  status: string | null;
  rank: number | null;
  deleted: boolean;
}
export interface ReturnSnapshot {
  cards: ReturnCard[];
  columns: CncTelegramTodayColumnDto[];
  orders: ReturnOrder[];
  details: ReturnDetail[];
  moves: {
    card_kind: string;
    card_id: string;
    target_column: string;
    version: number;
  }[];
  settings: unknown[];
  sourceFact: unknown;
}
const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
export function flattenReturnCards(
  columns: CncTelegramTodayColumnDto[]
): ReturnCard[] {
  const cards: ReturnCard[] = [];
  for (const c of columns) {
    for (const p of c.packets)
      cards.push({
        kind: "packet",
        id: p.packetId,
        label: `Файл ${p.cuttingSequenceNo ?? p.programName ?? p.packetId}`,
        column: c.key,
        members: p.items.map((i) => ({
          detailId: positive(i.matchDetailId),
          orderId: positive(i.matchOrderId ?? i.orderId),
          quantity: i.quantity,
        })),
      });
    for (const b of c.baths)
      cards.push({
        kind: "bath",
        id: b.bathCardId,
        label: `Ванна ${b.displayCutNumber ?? b.cutNumber}`,
        column: c.key,
        members: b.items.map((i) => ({
          detailId: positive(i.detailId),
          orderId: positive(i.orderId),
          quantity: i.quantity,
        })),
      });
    for (const b of c.bazisCutSets ?? [])
      cards.push({
        kind: "bazisCutSet",
        id: String(b.bazisCutSetId),
        label: `БАЗИС ${b.name}`,
        column: c.key,
        members: b.items.map((i) => ({
          detailId: positive(i.detailId),
          orderId: positive(i.orderId),
          quantity: i.quantity,
        })),
      });
  }
  return cards.sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)
  );
}

export async function returnSourceOwners(
  db: DatabaseClient,
  kind: MdfReturnKind,
  id: string
): Promise<number[]> {
  const result = await db.query<{ order_id: string }>(
    `
    WITH names AS (SELECT lower(trim(order_name)) AS name, MIN(order_id) AS id FROM orders
      WHERE delete_flag=false AND order_kind='production_order' GROUP BY lower(trim(order_name)) HAVING COUNT(*)=1),
    owners AS (
      SELECT COALESCE(i.match_order_id,n.id) AS order_id FROM cnc_telegram_packet_items i
        LEFT JOIN names n ON n.name=lower(trim(i.order_name)) WHERE $1='packet' AND i.packet_id::text=$2
      UNION SELECT n.id FROM cnc_telegram_packet_whole_order_keys w JOIN names n ON n.name=w.order_key
        WHERE $1='packet' AND w.packet_id::text=$2
      UNION SELECT COALESCE(i.source_order_id,d.order_id) FROM bazis_cut_set_details i
        LEFT JOIN order_details d ON d.detail_id=i.source_order_detail_id WHERE $1='bazisCutSet' AND i.bazis_cut_set_id::text=$2
      UNION SELECT p.order_id FROM cut_result_placement p JOIN cut_result_sheet_map s
        ON s.cut_result_sheet_map_id=p.cut_result_sheet_map_id AND s.is_effective=true
        WHERE $1='bath' AND ('cut-result:' || p.cut_result_id::text)=$2)
    SELECT DISTINCT order_id FROM owners WHERE order_id IS NOT NULL ORDER BY order_id`,
    [kind, id]
  );
  const ids = result.rows.map((r) => Number(r.order_id));
  if (ids.length > 100) throw new ApiError(422,'MDF_RETURN_SCOPE_TOO_LARGE','Слишком много заказов для одного возврата');
  if (!ids.length)
    throw new ApiError(
      422,
      "MDF_RETURN_UNRESOLVED",
      "Не удалось однозначно определить состав карточки"
    );
  return ids;
}

export async function loadReturnSnapshot(
  db: DatabaseClient,
  source: { kind: MdfReturnKind; id: string },
  ownerIds: number[],
  boardWindow?: { dateFrom: string; dateTo: string }
): Promise<ReturnSnapshot> {
  // Include the other owners of mixed baths for correct readiness of their full membership.
  const related = await db.query<{ order_id: string }>(
    `SELECT DISTINCT sibling.order_id FROM cut_result_placement sibling
    JOIN cut_result_placement member ON member.cut_result_id=sibling.cut_result_id
    WHERE member.order_id=ANY($1::bigint[]) AND sibling.order_id IS NOT NULL`,
    [ownerIds]
  );
  const scope = [
    ...new Set([...ownerIds, ...related.rows.map((r) => Number(r.order_id))]),
  ].sort((a, b) => a - b);
  if (scope.length > 100)
    throw new ApiError(
      422,
      "MDF_RETURN_SCOPE_TOO_LARGE",
      "Слишком много связанных заказов для одного возврата"
    );
  const columns = await loadMdfReturnSources(db, scope, boardWindow);
  const cards = flattenReturnCards(columns);
  const allOwnerIds = [
    ...new Set([
      ...scope,
      ...cards.flatMap((c) =>
        c.members.flatMap((m) => (m.orderId ? [m.orderId] : []))
      ),
    ]),
  ].sort((a, b) => a - b);
  const orders = await db.query<ReturnOrder>(
    `SELECT o.order_id::integer AS id,o.order_name AS name,
    o.order_status_id::integer AS "statusId",s.order_status_name AS status,o.version::integer AS version,
    COALESCE(s.sort_order >= (SELECT MIN(sort_order) FROM order_statuses WHERE lower(trim(order_status_name))='выдан'),false) AS "issuedOrLater",
    o.created_by::text AS "createdBy",o.manager_id::text AS "managerId",o.delete_flag AS deleted,o.order_kind AS kind,
    ARRAY(SELECT u.user_id::text FROM order_workshops w JOIN users u ON u.employee_id=w.responsible_employee_id
      WHERE w.order_id=o.order_id AND w.delete_flag=false AND u.is_active=true ORDER BY u.user_id) AS assigned
    FROM orders o LEFT JOIN order_statuses s ON s.order_status_id=o.order_status_id
    WHERE o.order_id=ANY($1::bigint[]) ORDER BY o.order_id`,
    [allOwnerIds]
  );
  const details = await db.query<ReturnDetail>(
    `SELECT d.detail_id::integer AS id,d.order_id::integer AS "orderId",
    d.detail_number AS number,d.quantity,d.production_status_id::integer AS "statusId",
    s.production_status_name AS status,s.sort_order AS rank,COALESCE(d.delete_flag,false) AS deleted
    FROM order_details d LEFT JOIN production_statuses s ON s.production_status_id=d.production_status_id
    WHERE d.order_id=ANY($1::bigint[]) ORDER BY d.detail_id`,
    [allOwnerIds]
  );
  const wholeOrders = await db.query<{
    packet_id: string;
    order_id: string | null;
  }>(
    `WITH names AS (
      SELECT lower(trim(order_name)) AS name,MIN(order_id) AS id FROM orders
      WHERE delete_flag=false AND order_kind='production_order' GROUP BY lower(trim(order_name)) HAVING COUNT(*)=1)
    SELECT w.packet_id::text,n.id AS order_id FROM cnc_telegram_packet_whole_order_keys w
    LEFT JOIN names n ON n.name=w.order_key WHERE w.packet_id::text=ANY($1::text[]) ORDER BY w.packet_id,w.order_key`,
    [cards.filter((c) => c.kind === "packet").map((c) => c.id)]
  );
  for (const card of cards.filter((c) => c.kind === "packet")) {
    const claims = wholeOrders.rows.filter((w) => w.packet_id === card.id);
    if (
      source.kind === "packet" &&
      source.id === card.id &&
      claims.some((w) => !w.order_id)
    ) {
      throw new ApiError(
        422,
        "MDF_RETURN_UNRESOLVED",
        "Не удалось сопоставить отметку «весь заказ» в файле"
      );
    }
    card.wholeOrderIds = claims.flatMap((w) =>
      w.order_id ? [Number(w.order_id)] : []
    );
    for (const d of details.rows.filter(
      (d) => !d.deleted && card.wholeOrderIds!.includes(d.orderId)
    )) {
      card.members = card.members.filter((m) => m.detailId !== d.id);
      card.members.push({
        detailId: d.id,
        orderId: d.orderId,
        quantity: d.quantity,
      });
    }
  }
  const moves = await db.query<ReturnSnapshot["moves"][number]>(
    `SELECT card_kind,card_id,target_column,version
    FROM mdf_board_manual_moves WHERE (card_kind || ':' || card_id)=ANY($1::text[]) ORDER BY card_kind,card_id`,
    [cards.map((c) => `${c.kind}:${c.id}`)]
  );
  const settings =
    await db.query(`SELECT setting_key,value_json,is_active FROM app_settings
    WHERE setting_key='status_automation.mdf_board_hidden_production_statuses' ORDER BY setting_key`);
  const rules =
    await db.query(`SELECT id,version,is_enabled,conditions_json,action_config_json,target_status_id
    FROM status_automation_rules ORDER BY id`);
  const fact =
    source.kind === "packet"
      ? await db.query(
          `SELECT packet_id,source_version,payload_hash,completion_status,thumbs_up,completed_at,
        mdf_completion_returned,mdf_board_hidden_at FROM cnc_telegram_packets WHERE packet_id::text=$1`,
          [source.id]
        )
      : source.kind === "bazisCutSet"
      ? await db.query(
          `SELECT bazis_cut_set_id,name,created_at FROM bazis_cut_sets WHERE bazis_cut_set_id::text=$1`,
          [source.id]
        )
      : await db.query(
          `SELECT r.cut_result_id,r.snapshot_digest,j.status,j.current_cut_result_id
          FROM cut_result r JOIN cut_job j ON j.cut_job_id=r.cut_job_id WHERE ('cut-result:' || r.cut_result_id::text)=$1`,
          [source.id]
        );
  const moveByKey = new Map(
    moves.rows.map((m) => [`${m.card_kind}:${m.card_id}`, m.target_column])
  );
  const setting = settings.rows.find((s) => s.is_active)?.value_json;
  for (const card of cards) {
    if (
      card.kind !== "packet" &&
      hiddenByOrderRule(card, orders.rows, setting)
    ) {
      card.column =
        card.kind === "bath" ? "completed_baths" : "completed_laminated";
    }
    card.column = resolveMdfProductionColumn(
      card.column,
      moveByKey.get(`${card.kind}:${card.id}`)
    );
  }
  return {
    cards,
    columns,
    orders: orders.rows,
    details: details.rows,
    moves: moves.rows,
    settings: [...settings.rows, ...rules.rows],
    sourceFact: fact.rows,
  };
}

function hiddenByOrderRule(
  card: ReturnCard,
  orders: ReturnOrder[],
  setting: unknown
): boolean {
  const value =
    setting && typeof setting === "object"
      ? (setting as Record<string, unknown>)
      : {};
  let ids: unknown = value.orderStatusIds;
  if (Array.isArray(value.cardRules)) {
    const rule = value.cardRules.find(
      (r: unknown) =>
        r &&
        typeof r === "object" &&
        "cardKind" in r &&
        r.cardKind === card.kind
    );
    ids =
      rule && typeof rule === "object" && "orderStatusIds" in rule
        ? rule.orderStatusIds
        : [];
  }
  return (
    card.members.length > 0 &&
    card.members.every((m) => {
      const o = orders.find((o) => o.id === m.orderId);
      if (!o || o.deleted) return false;
    return Array.isArray(ids)
      ? ids.map(Number).filter(n=>Number.isSafeInteger(n) && n>0).includes(o.statusId ?? 0)
        : o.issuedOrLater ||
            ["выдан", "завершен", "завершён"].includes(
              (o.status ?? "").trim().toLowerCase()
            );
    })
  );
}
