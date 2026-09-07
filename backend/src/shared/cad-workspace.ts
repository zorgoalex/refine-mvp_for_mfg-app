/** Pure shared document rules. No ERP queries or milling geometry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CadRecipeRef { code: string; version: string; parameters: Record<string, JsonValue> }
export interface CadSourcePart {
  orderId: number; detailId: number; detailNumber: number; widthMm: number; heightMm: number; quantity: number;
  thicknessMm: number | null; material: string | null; millingTypeId: number | null;
  millingName: string; edgeName: string; recipe: CadRecipeRef | null;
}
export interface CadSourceSnapshot { id: string; orderId: number; orderName: string; capturedAt: string; parts: CadSourcePart[] }
export interface CadGroup {
  id: string; sourceSnapshotId: string; orderId: number; detailId: number; quantity: number; recipe: CadRecipeRef | null;
  xMm: number; yMm: number; rotationDeg: number; placementGroupId?: string;
}
export interface CadVariant {
  id: string; workspaceId: string; name: string; kind: 'original' | 'working'; version: number;
  groups: CadGroup[]; sources: CadSourceSnapshot[]; createdAt: string; parentId: string | null;
  jobId: string | null; renderRevision: number | null;
}
export interface CadCompositionIssue { code: string; message: string; groupId?: string; orderId?: number; detailId?: number }
export class CadDocumentError extends Error {
  constructor(readonly code: string, message: string, readonly issues: CadCompositionIssue[] = []) { super(message); }
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export const recipesEqual = (a: CadRecipeRef | null | undefined, b: CadRecipeRef | null | undefined): boolean => same(a, b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function createGroups(sources: CadSourceSnapshot[], idGenerator: () => string): CadGroup[] {
  let x = 0, y = 0, rowHeight = 0;
  return sources.flatMap(s => s.parts.map(p => {
    if (x && x + p.widthMm > 5000) { x = 0; y += rowHeight + 50; rowHeight = 0; }
    const group: CadGroup = { id: idGenerator(), sourceSnapshotId: s.id, orderId: s.orderId, detailId: p.detailId,
      quantity: p.quantity, recipe: structuredClone(p.recipe), xMm: x, yMm: y, rotationDeg: 0 };
    x += Math.max(30, p.widthMm) + 50; rowHeight = Math.max(rowHeight, p.heightMm);
    return group;
  }));
}
export function validateComposition(groups: CadGroup[], sources: CadSourceSnapshot[]): CadCompositionIssue[] {
  const issues: CadCompositionIssue[] = [];
  if (!groups.length || groups.length > 500) issues.push({ code: 'GROUP_LIMIT', message: 'В версии должно быть от 1 до 500 групп' });
  const sourceIds = new Set<string>(), orderIds = new Set<number>(), groupIds = new Set<string>();
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  for (const s of sources) {
    if (sourceIds.has(s.id) || orderIds.has(s.orderId)) issues.push({ code: 'SOURCE_DUPLICATE', message: `Заказ ${s.orderId}: допустим один снимок`, orderId: s.orderId });
    sourceIds.add(s.id); orderIds.add(s.orderId);
    if (new Set(s.parts.map(p => p.detailId)).size !== s.parts.length || s.parts.some(p => p.orderId !== s.orderId)) issues.push({ code: 'SOURCE_INVALID', message: 'Некорректный состав снимка', orderId: s.orderId });
  }
  const totals = new Map<string, number>();
  for (const g of groups) {
    const add = (code: string, message: string) => issues.push({ code, message, groupId: g.id, orderId: g.orderId, detailId: g.detailId });
    if (groupIds.has(g.id)) add('GROUP_DUPLICATE', 'Повтор идентификатора группы');
    groupIds.add(g.id);
    if (![g.xMm, g.yMm, g.rotationDeg].every(Number.isFinite)) add('PLACEMENT_INVALID', 'Координаты и поворот должны быть конечными числами');
    if (!Number.isSafeInteger(g.quantity) || g.quantity <= 0) add('QUANTITY_INVALID', 'Количество должно быть положительным целым');
    const source = sourceMap.get(g.sourceSnapshotId), part = source?.parts.find(p => p.detailId === g.detailId);
    if (!source || source.orderId !== g.orderId || !part) { add('SOURCE_PART_MISSING', `Заказ ${g.orderId}: исходная позиция ${g.detailId} отсутствует`); continue; }
    const key = `${g.orderId}:${g.detailId}`;
    totals.set(key, (totals.get(key) ?? 0) + g.quantity);
    if (![part.widthMm, part.heightMm].every(n => Number.isFinite(n) && n >= 30)) add('CNC_MINIMUM_SIZE', 'Обе стороны детали должны быть не меньше 30 мм');
    if ((totals.get(key) ?? 0) > part.quantity) add('QUANTITY_EXCEEDED', `Заказ ${g.orderId}, позиция ${part.detailNumber}: превышено доступное количество ${part.quantity}`);
  }
  return issues;
}
export function applyVariantChanges(variant: CadVariant, expectedVersion: number, groups: CadGroup[], sources: CadSourceSnapshot[]): CadVariant {
  if (variant.kind === 'original') throw new CadDocumentError('CAD_ORIGINAL_IMMUTABLE', 'Оригинал нельзя менять');
  if (variant.version !== expectedVersion) throw new CadDocumentError('CAD_STALE_VERSION', 'Версия уже изменена другим пользователем');
  for (const source of sources) {
    const previous = variant.sources.find(s => s.orderId === source.orderId);
    if (previous && !same(previous, source)) throw new CadDocumentError('CAD_SOURCE_IMMUTABLE', 'Обновление источника создаёт новую версию');
  }
  const previousGroups = new Map(variant.groups.map(g => [g.id, g]));
  for (const group of groups) {
    const previous = previousGroups.get(group.id);
    if (previous && (previous.sourceSnapshotId !== group.sourceSnapshotId || previous.orderId !== group.orderId || previous.detailId !== group.detailId)) throw new CadDocumentError('CAD_PROVENANCE_IMMUTABLE', 'Нельзя подменять источник существующей группы');
  }
  const issues = validateComposition(groups, sources);
  if (issues.length) throw new CadDocumentError('CAD_COMPOSITION_INVALID', 'Исправьте конфликты состава', issues);
  return { ...structuredClone(variant), groups: structuredClone(groups), sources: structuredClone(sources), version: variant.version + 1, jobId: null, renderRevision: null };
}
export function cloneVariant(variant: CadVariant, id: string, name: string, now: string): CadVariant {
  if (!name.trim()) throw new CadDocumentError('CAD_NAME_REQUIRED', 'Укажите имя версии');
  return { ...structuredClone(variant), id, name: name.trim(), kind: 'working', version: 1, createdAt: now, parentId: variant.id, jobId: null, renderRevision: null };
}
export function refreshVariant(variant: CadVariant, freshSnapshots: CadSourceSnapshot[], id: string, name: string, now: string): { variant: CadVariant; issues: CadCompositionIssue[] } {
  const next = cloneVariant(variant, id, name, now);
  next.sources = variant.sources.map(old => {
    const fresh = freshSnapshots.find(s => s.orderId === old.orderId);
    if (!fresh) throw new CadDocumentError('CAD_SOURCE_REQUIRED', `Нет актуального снимка заказа ${old.orderId}`);
    return structuredClone(fresh);
  });
  next.groups = next.groups.map(g => {
    const oldPart = variant.sources.find(s => s.id === g.sourceSnapshotId)?.parts.find(p => p.detailId === g.detailId);
    const fresh = next.sources.find(s => s.orderId === g.orderId)!;
    const freshPart = fresh.parts.find(p => p.detailId === g.detailId);
    // Deliberate overrides remain exact; unchanged choices follow the refreshed source mapping.
    return { ...g, sourceSnapshotId: fresh.id, recipe: same(g.recipe, oldPart?.recipe) && freshPart ? structuredClone(freshPart.recipe) : g.recipe };
  });
  return { variant: next, issues: validateComposition(next.groups, next.sources) };
}
