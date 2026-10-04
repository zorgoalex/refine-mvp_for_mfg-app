import type {
  AllocationSuggestionCandidateDto,
  AllocationSuggestionLineDto,
  OnecUnitCode,
} from '../application/onec-documents.types';
import type { OrderResourceKind, OrderResourceUnit, OrderResourceSource } from '../application/order-resource-demand.types';
import type { WorklistUrgency } from '../application/procurement-workspace.types';
import { convertThousandths, DEMAND_EPSILON, fromDemandFloor, inDemandExact, MAX_REQUEST_LINKS_PER_ALLOCATION, supplierMatch } from './supplier-request-links';
import {
  demandUnitOf,
  fromThousandths,
  toDemandUnit,
  toDocUnitFloor,
  toThousandths,
  type ProcurementDocUnit,
} from './procurement-worklist';

export interface SuggestionLineInput {
  lineId: number;
  lineNo: number;
  nomenclatureName: string | null;
  material: { resourceKey: string; kind: OrderResourceKind; refId: number; name: string } | null;
  docUnit: OnecUnitCode | null;
  sheetAreaM2: number | null;
  capacityInDocUnit: number;
  /** Сумма активных распределений строки, в единице строки. */
  allocatedInDocUnit: number;
  /** Заказ, указанный в строке 1С (ref_key заказа), если есть. */
  onecOrderRefKey: string | null;
  /** Строка удалена в 1С (загрузчик R1-2) — в подбор не попадает. */
  removedInOnec?: boolean;
  /** Изменение 1С в конфликте с распределениями (R2-1) — в подбор не попадает. */
  onecConflict?: boolean;
}

export interface SuggestionCandidateInput {
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  orderRefKey1c: string | null;
  resourceKey: string;
  need: number | null;
  /** Покрыто (приходы / ручная отметка) — как в рабочем списке, §4.1. */
  covered: number;
  source: OrderResourceSource;
  purchased: boolean;
  dueDate: string | null;
  urgency: WorklistUrgency;
  daysLeft: number | null;
  supplierKey: string;
  procurementVersion: number;
  demandFingerprint: string;
  /** Открытые строки отправленных заявок этого закупа (ф.3б), по sent_at, затем id. */
  openRequestLines?: OpenRequestLineInput[];
}

export interface OpenRequestLineInput {
  lineOrderId: number;
  supplierRequestId: number;
  requestNumber: string;
  supplierKey: string;
  unit: OnecUnitCode;
  /** Осталось получить: количество − привязанные приходы, тысячные единицы строки заявки. */
  remaining: number;
}

export interface SuggestionPlanInput {
  lines: SuggestionLineInput[];
  candidates: SuggestionCandidateInput[];
  /** Пары «строка × заказ» с активным распределением: не предлагаются (R2-3). */
  allocatedPairs: Set<string>;
  alreadyAllocated: Map<number, Array<{ orderId: number; orderName: string; quantityInDocUnit: number }>>;
  /** Все известные ключи поставщика документа (c: ref 1С, s: поставщик ERP, n: имя) — совпадение = любой из них. */
  documentSupplierKeys: readonly string[];
  /** Идентичность поставщика документа — для сверки с поставщиком заявки (ф.3б). */
  documentSupplier?: { supplierId: number | null; counterpartyRefKey: string | null };
  wastePercent: number;
  /** Не больше стольких предложенных распределений на документ — лимит одной атомарной команды (CR1-2). */
  maxProposals: number;
}

const URGENCY_RANK: Record<WorklistUrgency, number> = { overdue: 0, critical: 1, soon: 2, normal: 3, no_date: 4 };

export function pairKey(lineId: number, orderId: number): string {
  return `${lineId}|${orderId}`;
}

/**
 * Автоподбор заказов для прихода (план §5.3 + R1-6, R2-3, R3-6, R4-4): строки по `line_no`, общий
 * уменьшаемый остаток потребности по «заказ × материал» на весь документ, запас на обрезки — один раз и
 * только для потребности по площади; количество — вниз до 0,001 после перевода в единицу строки.
 * Детерминированно: одинаковый вход → одинаковый ответ. Только чтение.
 */
export function planAllocationSuggestions(input: SuggestionPlanInput): { lines: AllocationSuggestionLineDto[]; limitReached: boolean } {
  let proposals = 0;
  let limitReached = false;
  const wasteFactor = 1 + Math.max(0, input.wastePercent) / 100;
  const remainingNeed = new Map<string, number>();
  for (const candidate of input.candidates) {
    if (candidate.need === null) continue;
    const deficit = Math.max(0, toThousandths(candidate.need) - toThousandths(candidate.covered));
    const withWaste = candidate.source === 'area' ? Math.round(deficit * wasteFactor) : deficit;
    remainingNeed.set(needKey(candidate.orderId, candidate.resourceKey), withWaste);
  }

  const result: AllocationSuggestionLineDto[] = [];
  // Остаток каждой связи заявки ведётся на весь подбор (R3-6), как и остаток потребности.
  const linkRemaining = new Map<number, number>();
  for (const candidate of input.candidates) {
    for (const open of candidate.openRequestLines ?? []) linkRemaining.set(open.lineOrderId, open.remaining);
  }
  const docIdentity = {
    supplierId: input.documentSupplier?.supplierId ?? null,
    counterpartyRefKey: input.documentSupplier?.counterpartyRefKey ?? null,
    keys: input.documentSupplierKeys,
  };
  for (const line of [...input.lines].sort((left, right) => left.lineNo - right.lineNo || left.lineId - right.lineId)) {
    const capacity = toThousandths(line.capacityInDocUnit);
    let left = Math.max(0, capacity - toThousandths(line.allocatedInDocUnit));
    const base = {
      lineId: line.lineId,
      lineNo: line.lineNo,
      nomenclatureName: line.nomenclatureName,
      material: line.material,
      docUnit: line.docUnit,
      demandUnit: line.material ? demandUnitOf(line.material.kind) : null,
      sheetAreaM2: line.sheetAreaM2,
      capacityInDocUnit: fromThousandths(capacity),
      remainingInDocUnit: fromThousandths(left),
      alreadyAllocated: input.alreadyAllocated.get(line.lineId) ?? [],
    };
    const skip = (skipReason: AllocationSuggestionLineDto['skipReason']): AllocationSuggestionLineDto =>
      ({ ...base, skipReason, candidates: [], surplusInDocUnit: fromThousandths(left) });
    if (line.removedInOnec) { result.push(skip('removed_in_onec')); continue; }
    if (line.onecConflict) { result.push(skip('onec_conflict')); continue; }
    if (!line.material) { result.push(skip('not_mapped')); continue; }
    const demandUnit = demandUnitOf(line.material.kind);
    const geometry = { sheetAreaM2: line.sheetAreaM2 };
    const docUnit = line.docUnit as ProcurementDocUnit | null;
    if (toDemandUnit(1, docUnit, demandUnit, geometry) === null) { result.push(skip('incompatible_unit')); continue; }
    if (left <= 0) { result.push(skip('fully_allocated')); continue; }

    const ranked = input.candidates
      .filter((candidate) => candidate.resourceKey === line.material!.resourceKey)
      .filter((candidate) => !input.allocatedPairs.has(pairKey(line.lineId, candidate.orderId)))
      .map((candidate) => ({ candidate, need: remainingNeed.get(needKey(candidate.orderId, candidate.resourceKey)) ?? 0 }))
      .filter(({ need }) => need > 0)
      .map((entry) => ({ ...entry, links: eligibleLinks(entry.candidate, line, demandUnit, docIdentity, linkRemaining) }))
      .sort((a, b) => compareCandidates(a, b, line, left, demandUnit, docUnit, geometry, input.documentSupplierKeys));

    // Количество в единице строки — вниз до 0,001; хвост меньше 0,001 единицы строки (0,001 листа ≈ 0,006 м²)
    // закрытием не мешает: заказ считается закрытым полностью и хвост не предлагается другим строкам.
    const slack = toThousandths(toDemandUnit(0.001, docUnit, demandUnit, geometry) ?? 0);
    const candidates: AllocationSuggestionCandidateDto[] = [];
    for (const { candidate, need, links } of ranked) {
      const needInDoc = toDocUnitFloor(fromThousandths(need), demandUnit, docUnit, geometry) ?? 0;
      let take = Math.min(toThousandths(needInDoc), left);
      // Предложение целиком должно пройти одной командой: сверх лимита — кандидат без количества.
      if (take > 0 && proposals >= input.maxProposals) { take = 0; limitReached = true; }
      if (take > 0) proposals += 1;
      const proposedDemand = take > 0 ? toThousandths(toDemandUnit(fromThousandths(take), docUnit, demandUnit, geometry) ?? 0) : 0;
      const requestLinks = take > 0 ? splitAcrossRequestLines(take, links, line.docUnit, demandUnit, line.sheetAreaM2, linkRemaining) : [];
      if (take > 0) {
        left -= take;
        const rest = need - proposedDemand;
        remainingNeed.set(needKey(candidate.orderId, candidate.resourceKey), rest <= slack ? 0 : rest);
      }
      candidates.push({
        orderId: candidate.orderId,
        orderName: candidate.orderName,
        fullNumber: candidate.fullNumber,
        clientName: candidate.clientName,
        dueDate: candidate.dueDate,
        urgency: candidate.urgency,
        daysLeft: candidate.daysLeft,
        demandUnit,
        needInDemandUnit: candidate.need ?? 0,
        deficitInDemandUnit: fromThousandths(need),
        proposedInDocUnit: fromThousandths(take),
        proposedInDemandUnit: fromThousandths(proposedDemand),
        reasons: reasonsFor(candidate, line, input.documentSupplierKeys, take, proposedDemand, need, slack, links),
        requestLinks,
        purchased: candidate.purchased,
        procurementVersion: candidate.procurementVersion,
        demandFingerprint: candidate.demandFingerprint,
      });
    }
    result.push({ ...base, skipReason: null, candidates, surplusInDocUnit: fromThousandths(left) });
  }
  return { lines: result, limitReached };
}

function needKey(orderId: number, resourceKey: string): string {
  return `${orderId}|${resourceKey}`;
}

function compareCandidates(
  a: { candidate: SuggestionCandidateInput; need: number; links: OpenRequestLineInput[] },
  b: { candidate: SuggestionCandidateInput; need: number; links: OpenRequestLineInput[] },
  line: SuggestionLineInput,
  left: number,
  demandUnit: OrderResourceUnit,
  docUnit: ProcurementDocUnit | null,
  geometry: { sheetAreaM2: number | null },
  documentSupplierKeys: readonly string[],
): number {
  const onec = (c: SuggestionCandidateInput) => (line.onecOrderRefKey !== null && c.orderRefKey1c === line.onecOrderRefKey ? 0 : 1);
  const unmarked = (c: SuggestionCandidateInput) => (c.purchased ? 1 : 0);
  const supplier = (c: SuggestionCandidateInput) => (documentSupplierKeys.includes(c.supplierKey) ? 0 : 1);
  const closes = (need: number) => (toThousandths(toDocUnitFloor(fromThousandths(need), demandUnit, docUnit, geometry) ?? 0) <= left ? 0 : 1);
  // §5.3 п.2: заказ в открытой заявке этому поставщику на этот материал — сразу после указанного в 1С.
  const requested = (links: OpenRequestLineInput[]) => (links.length > 0 ? 0 : 1);
  return onec(a.candidate) - onec(b.candidate)
    || requested(a.links) - requested(b.links)
    || URGENCY_RANK[a.candidate.urgency] - URGENCY_RANK[b.candidate.urgency]
    || (a.candidate.dueDate ?? '9999-12-31').localeCompare(b.candidate.dueDate ?? '9999-12-31')
    || unmarked(a.candidate) - unmarked(b.candidate)
    || supplier(a.candidate) - supplier(b.candidate)
    || closes(a.need) - closes(b.need)
    || a.candidate.orderId - b.candidate.orderId;
}

function reasonsFor(
  candidate: SuggestionCandidateInput,
  line: SuggestionLineInput,
  documentSupplierKeys: readonly string[],
  take: number,
  proposedDemand: number,
  need: number,
  slack: number,
  links: OpenRequestLineInput[] = [],
): AllocationSuggestionCandidateDto['reasons'] {
  const reasons: AllocationSuggestionCandidateDto['reasons'] = [];
  if (line.onecOrderRefKey !== null && candidate.orderRefKey1c === line.onecOrderRefKey) {
    reasons.push({ code: 'onec_order', label: 'указан в 1С', tone: 'info' });
  }
  if (links.length > 0) {
    reasons.push({ code: 'request', label: `по заявке ${[...new Set(links.map((link) => link.requestNumber))].join(', ')}`, tone: 'info' });
  }
  if (candidate.daysLeft !== null && candidate.urgency !== 'normal') {
    reasons.push({
      code: 'due',
      label: candidate.daysLeft < 0 ? `просрочено на ${-candidate.daysLeft} дн.` : candidate.daysLeft === 0 ? 'в цех сегодня' : `в цех через ${candidate.daysLeft} дн.`,
      tone: candidate.urgency === 'soon' ? 'warning' : 'error',
    });
  }
  if (!candidate.purchased) reasons.push({ code: 'unmarked', label: 'без отметки', tone: 'default' });
  if (documentSupplierKeys.includes(candidate.supplierKey)) {
    reasons.push({ code: 'supplier', label: 'поставщик совпадает', tone: 'success' });
  }
  if (take > 0) {
    reasons.push(proposedDemand + slack >= need
      ? { code: 'closes', label: 'закрывает полностью', tone: 'success' }
      : { code: 'closes', label: 'закроет частично', tone: 'warning' });
  }
  return reasons;
}

/**
 * Открытые строки заявок кандидата, допустимые для этой строки документа (§5.3, R4-4): поставщик заявки не
 * расходится с поставщиком документа («match» — известно, что тот же), единицы пересчитываются, остаток > 0.
 * Для ранжирования и связей — только «match» и «unknown» без явного расхождения; порядок входа (sent_at, id).
 */
function eligibleLinks(
  candidate: SuggestionCandidateInput,
  line: SuggestionLineInput,
  demandUnit: OrderResourceUnit,
  doc: { supplierId: number | null; counterpartyRefKey: string | null; keys: readonly string[] },
  remaining: Map<number, number>,
): OpenRequestLineInput[] {
  // Исчерпанная прошлыми строками документа заявка приоритета не даёт (CR2-4).
  return (candidate.openRequestLines ?? []).filter((open) =>
    (remaining.get(open.lineOrderId) ?? 0) > 0
    && supplierMatch(open.supplierKey, doc) === 'match'
    && convertThousandths(1000, open.unit, line.docUnit, demandUnit, line.sheetAreaM2) !== null);
}

/**
 * Разбиение предложенного количества строки документа по открытым строкам заявок (§5.3): по порядку, в пределах их
 * остатка на весь подбор; количество связи — в единице строки заявки, вниз до 0,001 (сумма связей в единице строки
 * документа не превышает распределения — проверка batch). Остаток сверх связей — без ссылки.
 */
function splitAcrossRequestLines(
  takeInDoc: number,
  links: OpenRequestLineInput[],
  docUnit: OnecUnitCode | null,
  demandUnit: OrderResourceUnit,
  sheetAreaM2: number | null,
  remaining: Map<number, number>,
): AllocationSuggestionCandidateDto['requestLinks'] {
  const result: AllocationSuggestionCandidateDto['requestLinks'] = [];
  // Остаток прихода — в единице потребности без округления; связи — вниз до 0,001 единицы заявки, поэтому их сумма
  // не превышает распределения (та же точная проверка в batch, CR1-2).
  let restDemand = inDemandExact(takeInDoc / 1000, docUnit, demandUnit, sheetAreaM2) ?? 0;
  for (const link of links) {
    // Не больше, чем принимает batch (CR1-7); остаток — без ссылки.
    if (restDemand <= DEMAND_EPSILON || result.length >= MAX_REQUEST_LINKS_PER_ALLOCATION) break;
    const left = remaining.get(link.lineOrderId) ?? 0;
    if (left <= 0) continue;
    const restInRequest = fromDemandFloor(restDemand, link.unit, demandUnit, sheetAreaM2);
    if (restInRequest === null) continue;
    const part = Math.min(left, Math.round(restInRequest * 1000));
    if (part <= 0) continue;
    remaining.set(link.lineOrderId, left - part);
    restDemand -= inDemandExact(part / 1000, link.unit, demandUnit, sheetAreaM2) ?? 0;
    result.push({ lineOrderId: link.lineOrderId, supplierRequestId: link.supplierRequestId, requestNumber: link.requestNumber, quantity: part / 1000, unit: link.unit });
  }
  return result;
}
