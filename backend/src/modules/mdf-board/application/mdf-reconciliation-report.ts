import type { DatabaseClient } from '../../../database/database.types';
import { checkMdfShadowParity, loadMdfReconciliationInventory, type MdfReconciliationInventory } from '../adapters/mdf-reconciliation-inventory';
import { buildMdfReconciliationComponents, classifyMdfReconciliationSource, evaluateMdfReconciliationComponent,
  MDF_WORKER_LIMITS, type MdfReconciliationEvaluation, type MdfReconciliationSource } from '../domain/mdf-reconciliation';
import { mdfPositionKey } from '../domain/mdf-quantities';

export const MDF_RECONCILIATION_ALGORITHM = 'mdf-reconciliation/v1';

export interface MdfReconciliationReport {
  manifest: Record<string, unknown>;
  totals: Record<string, unknown>;
  invariants: { name: string; ok: boolean; detail: string[] }[];
  sources: (MdfReconciliationSource & { engineColumn: string | null; engineReason: string; engineVerified: boolean;
    reservedQuantity: number;
    quarantine: string[] })[];
  components: ReturnType<typeof buildMdfReconciliationComponents>;
  orders: { id: number; name: string; status: string | null; required: number; creditedCut: number; creditedRolled: number;
    remaining: number; unverifiedQuantity: number; readyOrIssuedWithoutProof: boolean; legacyCompletedEngineNot: boolean }[];
  references: MdfReconciliationInventory['references'];
}

/** Pure assembly from a loaded inventory (unit-testable without PG). */
export function buildMdfReconciliationReport(inventory: MdfReconciliationInventory, parityMismatches: readonly string[],
  manifest: Record<string, unknown>): MdfReconciliationReport {
  const classified = inventory.inputs.map(classifyMdfReconciliationSource);
  const demandByOrder = new Map<number, number>();
  for (const d of inventory.demand) demandByOrder.set(d.orderId, (demandByOrder.get(d.orderId) ?? 0) + 1);
  const components = buildMdfReconciliationComponents(classified, demandByOrder);
  const byKey = new Map(classified.map(s => [`${s.kind}:${s.id}`, s]));
  const reserved = new Map<string, number>(), quarantine = new Map<string, string[]>();
  const cards = new Map<string, MdfReconciliationEvaluation['cards'][number]>();
  const positions = new Map<string, { orderId: number; required: number; creditedCut: number; creditedRolled: number; remaining: number }>();
  const violations: string[] = [];
  for (const c of components) {
    const sources = c.sources.map(s => byKey.get(`${s.kind}:${s.id}`)!);
    const owners = new Set(c.orderIds);
    const evaluation = evaluateMdfReconciliationComponent(sources,
      inventory.demand.filter(d => owners.has(d.orderId)), inventory.thresholds);
    violations.push(...evaluation.invariantViolations);
    c.counts.allocations = evaluation.reservations.length;
    for (const r of evaluation.reservations) {
      reserved.set(`bath:${r.bathId}`, (reserved.get(`bath:${r.bathId}`) ?? 0) + r.quantity);
      // Supply is physical packet cut only: `packet:<uuid>:<line>`.
      const supplier = r.evidenceLineId.split(':').slice(0, 2).join(':');
      reserved.set(supplier, (reserved.get(supplier) ?? 0) + r.quantity);
    }
    for (const card of evaluation.cards) cards.set(`${card.kind}:${card.id}`, card);
    for (const q of evaluation.quarantine) {
      const k = `${q.sourceKind}:${q.sourceId}`; quarantine.set(k, [...(quarantine.get(k) ?? []), q.code]);
    }
    for (const p of evaluation.positions) positions.set(mdfPositionKey(p), { orderId: p.orderId, required: p.quantity,
      creditedCut: p.creditedCut, creditedRolled: p.creditedRolled, remaining: p.remaining });
  }
  const sources = classified.map(s => {
    const key = `${s.kind}:${s.id}`;
    // Placement exactly as the accepted projection publishes it (`mdfPlacement` inside `projectMdfAcceptedState`).
    const card = cards.get(key);
    return { ...s, engineColumn: card?.column ?? null,
      engineReason: card ? card.issues.length ? `${card.reason}:${card.issues.join(',')}` : card.reason : 'blocked',
      engineVerified: card?.verified ?? false,
      reservedQuantity: reserved.get(key) ?? 0, quarantine: (quarantine.get(key) ?? []).sort() };
  });

  const unverifiedByOrder = new Map<number, number>();
  for (const s of classified) for (const l of s.lines) if (s.unverifiedQuantity && l.stage === 'membership') {
    unverifiedByOrder.set(l.orderId, (unverifiedByOrder.get(l.orderId) ?? 0) + l.quantity);
  }
  const legacyCompleted = new Set(sources.filter(s => s.legacyColumn !== null
    && ['completed', 'completed_laminated', 'baths_laminated', 'completed_baths'].includes(s.legacyColumn)
    && !['completed', 'completed_laminated', 'baths_laminated', 'completed_baths'].includes(s.engineColumn ?? ''))
    .flatMap(s => s.owners));
  // Orders in no credited component (all sources unresolved) still show their live MDF demand with zero credit.
  for (const d of inventory.demand) if (!positions.has(mdfPositionKey(d))) positions.set(mdfPositionKey(d), { orderId: d.orderId,
    required: d.quantity, creditedCut: 0, creditedRolled: 0, remaining: d.quantity });
  const orderTotals = new Map<number, { required: number; creditedCut: number; creditedRolled: number; remaining: number }>();
  for (const p of positions.values()) {
    const t = orderTotals.get(p.orderId) ?? { required: 0, creditedCut: 0, creditedRolled: 0, remaining: 0 };
    t.required += p.required; t.creditedCut += p.creditedCut; t.creditedRolled += p.creditedRolled; t.remaining += p.remaining;
    orderTotals.set(p.orderId, t);
  }
  const orders = [...orderTotals].map(([id, t]) => {
    const order = inventory.orders.get(id);
    const status = order?.status ?? null;
    return { id, name: order?.name ?? '', status, ...t, unverifiedQuantity: unverifiedByOrder.get(id) ?? 0,
      readyOrIssuedWithoutProof: t.remaining > 0 && order?.readyOrLater === true,
      legacyCompletedEngineNot: legacyCompleted.has(id) };
  }).sort((a, b) => a.id - b.id);

  // Invariants: every inventory entry classified exactly once; per-kind totals reconcile; planner invariants; parity.
  const invariants: MdfReconciliationReport['invariants'] = [];
  const identities = new Set(inventory.inputs.map(i => `${i.kind}:${i.id}`));
  invariants.push({ name: 'classified_once', ok: identities.size === inventory.inputs.length && classified.length === identities.size,
    detail: [] });
  const perKind: string[] = [];
  for (const kind of ['packet', 'bazisCutSet', 'bath'] as const) {
    const all = classified.filter(s => s.kind === kind);
    const parts = ['credited', 'blocked', 'excluded'].map(d => all.filter(s => s.disposition === d).length);
    if (parts.reduce((a, b) => a + b, 0) !== all.length) perKind.push(kind);
  }
  invariants.push({ name: 'totals_reconcile', ok: !perKind.length, detail: perKind });
  invariants.push({ name: 'allocation_invariants', ok: !violations.length, detail: violations.slice(0, 50) });
  // Every credited source must pass the accepted projection as a verified baseline (demand, evidence contract).
  const unverified = sources.filter(s => s.disposition === 'credited' && !s.engineVerified).map(s => `${s.kind}:${s.id}:${s.engineReason}`);
  invariants.push({ name: 'credited_sources_verified_by_projection', ok: !unverified.length, detail: unverified.slice(0, 50) });
  invariants.push({ name: 'shadow_loader_parity', ok: !parityMismatches.length, detail: parityMismatches.slice(0, 50) });
  invariants.push({ name: 'consumed_zero', ok: true, detail: ['legacy has no physical lamination: consumed = 0 by construction'] });

  const count = (pred: (s: MdfReconciliationSource) => boolean) => classified.filter(pred).length;
  const reasons: Record<string, number> = {}, warnings: Record<string, number> = {};
  for (const s of classified) {
    if (s.reason) reasons[`${s.kind}/${s.reason}`] = (reasons[`${s.kind}/${s.reason}`] ?? 0) + 1;
    for (const w of s.warnings) warnings[`${s.kind}/${w}`] = (warnings[`${s.kind}/${w}`] ?? 0) + 1;
  }
  const sum = (f: (s: MdfReconciliationSource) => number) => classified.reduce((n, s) => n + f(s), 0);
  const qty = (s: MdfReconciliationSource, stage: string, evidence: string) =>
    s.lines.filter(l => l.stage === stage && l.evidence === evidence).reduce((n, l) => n + l.quantity, 0);
  const totals = {
    inventory: classified.length,
    byKind: Object.fromEntries((['packet', 'bazisCutSet', 'bath'] as const).map(k => [k, {
      credited: count(s => s.kind === k && s.disposition === 'credited'),
      blocked: count(s => s.kind === k && s.disposition === 'blocked'),
      excluded: count(s => s.kind === k && s.disposition === 'excluded') }])),
    reasons, warnings,
    quantities: { membership: sum(s => qty(s, 'membership', 'derived')), physicalCut: sum(s => qty(s, 'cut', 'physical')),
      declaredCut: sum(s => qty(s, 'cut', 'declaration')), declaredLaminated: sum(s => qty(s, 'laminated', 'declaration')),
      unverified: sum(s => s.unverifiedQuantity),
      auditedUnbound: sum(s => s.warnings.includes('HISTORY_AUDITED_UNBOUND') ? s.unverifiedQuantity : 0),
      reserved: [...reserved].filter(([k]) => k.startsWith('bath:')).reduce((n, [, q]) => n + q, 0), consumed: 0 },
    components: { total: components.length, oversize: components.filter(c => c.exceeded.length).length,
      largest: components[0]?.counts ?? null, limits: MDF_WORKER_LIMITS },
    orders: { total: orders.length, readyOrIssuedWithoutProof: orders.filter(o => o.readyOrIssuedWithoutProof).length,
      legacyCompletedEngineNot: orders.filter(o => o.legacyCompletedEngineNot).length },
  };
  return { manifest: { ...manifest, algorithm: MDF_RECONCILIATION_ALGORITHM }, totals, invariants, sources, components, orders,
    references: inventory.references };
}

/** Caller owns a READ ONLY REPEATABLE READ transaction on `db`. */
export async function runMdfReconciliation(db: DatabaseClient, manifest: Record<string, unknown>): Promise<MdfReconciliationReport> {
  const started = Date.now();
  const inventory = await loadMdfReconciliationInventory(db);
  const parity = await checkMdfShadowParity(db, inventory.inputs);
  const dump = (await db.query<Record<string, string>>(`SELECT current_database() db,(SELECT COUNT(*)::text FROM audit_log) audit_rows,
    (SELECT MAX(updated_at)::text FROM cnc_telegram_packets) packets_updated,(SELECT COUNT(*)::text FROM cnc_telegram_packets) packets,
    (SELECT COUNT(*)::text FROM bazis_cut_sets) bazis_sets,(SELECT COUNT(*)::text FROM cut_result) cut_results,
    (SELECT COUNT(*)::text FROM mdf_board_manual_moves) manual_moves,(SELECT COUNT(*)::text FROM mdf_board_history_events) history,
    (SELECT MAX(created_at)::text FROM audit_log) last_audit_at,transaction_timestamp()::text snapshot_at`)).rows[0];
  const report = buildMdfReconciliationReport(inventory, parity, { ...manifest, dump });
  report.manifest.runtimeMs = Date.now() - started;
  return report;
}

const REASON_TEXT: Record<string, string> = {
  HISTORY_SOURCE_MISSING: 'на источник есть ссылка (перенос/история/задание раскроя), но самой записи нет',
  HISTORY_OWNER_DELETED: 'все позиции принадлежат удалённым заказам/деталям',
  HISTORY_OWNER_NOT_PRODUCTION: 'владелец — не производственный заказ',
  HISTORY_NO_OWNER: 'позиции не сопоставлены ни с одним заказом',
  HISTORY_UNMATCHED_ITEMS: 'ни одна позиция не сопоставлена с живой деталью',
  HISTORY_INCOMPLETE_COMPOSITION: 'у источника нет состава',
  HISTORY_NOT_MDF: 'не МДФ (материал / не вакуумная ванна / нет МДФ-строк)',
  HISTORY_BATH_NOT_CURRENT: 'ванна не текущая (результат раскроя заменён или в архиве)',
  HISTORY_BATH_NOT_CURRENT_WITH_PRODUCTION: 'ванна не текущая, но на ней есть закатка — заказы на ручную проверку',
  HISTORY_UNVERIFIED: 'ручная колонка без независимого подтверждения — только размещение, 0 в зачёт',
  HISTORY_AUDITED_UNBOUND: 'ручной перенос есть в журнале аудита, но не привязан к составу — 0 в зачёт (вход для 5.7b)',
  HISTORY_OUTSIDE_MDF_DEMAND: 'деталь живая, но вне МДФ-спроса заказа (материал сменён / нет в спросе) — не зачитывается',
  HISTORY_PROOF_LIMIT: 'история доказательств источника больше лимита загрузчика — доказательства не зачтены',
  HISTORY_PARTIAL_ITEMS: 'часть позиций не сопоставлена: зачтены только сопоставленные',
  HISTORY_REWORK: 'переделка: состав без поставки',
  HISTORY_RETURNED: 'завершение возвращено: физического реза нет',
};

export function renderMdfReconciliationMarkdown(report: MdfReconciliationReport): string {
  const t = report.totals as Record<string, any>;
  const lines: string[] = [`# Сверка истории МДФ (§5.7a)`, '',
    `Алгоритм \`${String(report.manifest.algorithm)}\`, commit \`${String(report.manifest.commit)}\`, `
      + `снимок ${String((report.manifest.dump as Record<string, string>)?.snapshot_at)}, `
      + `время ${String(report.manifest.runtimeMs)} мс. Только чтение; запись в движок не выполнялась.`, '',
    '## Инварианты', '', ...report.invariants.map(i => `- ${i.ok ? 'OK' : 'FAIL'} \`${i.name}\`${i.detail.length ? ` — ${i.detail.slice(0, 10).join('; ')}` : ''}`),
    '', '## Источники', '', '| Вид | Зачтено | Заблокировано | Исключено |', '|---|---:|---:|---:|',
    ...Object.entries(t.byKind as Record<string, Record<string, number>>).map(([k, v]) => `| ${k} | ${v.credited} | ${v.blocked} | ${v.excluded} |`),
    '', '### Причины блокировки/исключения', '', '| Вид/причина | Кол-во | Смысл |', '|---|---:|---|',
    ...Object.entries(t.reasons as Record<string, number>).sort().map(([k, n]) => `| ${k} | ${n} | ${REASON_TEXT[k.split('/')[1]] ?? ''} |`),
    '', '### Предупреждения по зачтённым источникам', '', '| Вид/предупреждение | Кол-во | Смысл |', '|---|---:|---|',
    ...Object.entries(t.warnings as Record<string, number>).sort().map(([k, n]) => `| ${k} | ${n} | ${REASON_TEXT[k.split('/')[1]] ?? ''} |`),
    '', '## Количества', '', ...Object.entries(t.quantities as Record<string, number>).map(([k, n]) => `- ${k}: ${n}`),
    '', '## Компоненты и лимиты воркера', '',
    `Всего ${t.components.total}, превышают лимиты: ${t.components.oversize}. Лимиты: ${JSON.stringify(t.components.limits)}.`, '',
    ...report.components.filter(c => c.exceeded.length).slice(0, 30)
      .map(c => `- компонент ${c.id}: заказов ${c.counts.owners}, источников ${c.counts.sources}, превышено: ${c.exceeded.join(', ')}`),
    '', '## Заказы', '',
    `Заказов с МДФ-спросом в сверке: ${t.orders.total}. «Готов к выдаче» и позже (Выдан/Завершен) с остатком: `
      + `${t.orders.readyOrIssuedWithoutProof}. На старой доске завершены, в движке нет: ${t.orders.legacyCompletedEngineNot}.`, '',
    '### «Готов к выдаче» и позже с остатком (ручная проверка)', '', '| Заказ | Статус | Требуется | Рез | Закатка | Остаток | Без подтверждения |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...report.orders.filter(o => o.readyOrIssuedWithoutProof).slice(0, 200)
      .map(o => `| ${o.name || o.id} | ${o.status ?? ''} | ${o.required} | ${o.creditedCut} | ${o.creditedRolled} | ${o.remaining} | ${o.unverifiedQuantity} |`),
    '', '## Ссылки', '', `Всего ссылок ${report.references.total}: ${JSON.stringify(report.references.byOrigin)}.`,
    'Субъекты истории, которые не являются источниками доски (не входят в инвентарь):', '',
    ...report.references.nonSource.map(n => `- ${n.entityType} (${n.reason}): ${n.subjects}`), '',
    'Подробности по каждой карточке и заказу — в JSON-версии отчёта.', ''];
  return lines.join('\n');
}
