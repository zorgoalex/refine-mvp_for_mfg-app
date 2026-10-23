/**
 * ETL entities of the agent configuration that ERP manages itself: the operator neither sees nor edits them, and
 * every published version gets them from the ERP state, whoever publishes.
 *
 * `stock_balances_at` — the service set of stock snapshots («срезы остатков на дату»): the 1C stock register as
 * of `Period`. The moment is part of the path, so another moment is another published version plus an explicit
 * full sync of this one set; between snapshots the set stays in the configuration switched off (agent
 * to-erp/0172, 0174, 0175). The code never changes: the agent keeps one state row per code.
 */
export const STOCK_SNAPSHOT_ENTITY_CODE = 'stock_balances_at';
export const MANAGED_ENTITY_CODES: ReadonlySet<string> = new Set([STOCK_SNAPSHOT_ENTITY_CODE]);

const STOCK_REGISTER = 'AccumulationRegister_ЗапасыНаСкладах';
const STOCK_DIMENSIONS = ['Организация', 'Номенклатура', 'Характеристика', 'Партия', 'СтруктурнаяЕдиница', 'Ячейка'] as const;
export const STOCK_SNAPSHOT_KEY_FIELDS = STOCK_DIMENSIONS.map((dimension) => `${dimension}_Key`);
export const STOCK_SNAPSHOT_QUANTITY_FIELD = 'КоличествоBalance';
const PERIOD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** What the configuration must carry for the service set of a source now. */
export interface ManagedStockSlot {
  enabled: boolean;
  /** `YYYY-MM-DDTHH:MM:SS`, local time of the 1C base. */
  periodLocal: string;
}

export function stockSnapshotPath(periodLocal: string): string {
  if (!PERIOD.test(periodLocal)) throw new Error(`stock snapshot period must be YYYY-MM-DDTHH:MM:SS, got ${periodLocal}`);
  return `${STOCK_REGISTER}/Balance(Period=datetime'${periodLocal}',Dimensions='${STOCK_DIMENSIONS.join(',')}')`;
}

/** The entity exactly as the agent team defined it (to-erp/0172): `stock_balances` with `Period` in the path. */
export function managedStockEntity(slot: ManagedStockSlot): Record<string, unknown> {
  return {
    entityCode: STOCK_SNAPSHOT_ENTITY_CODE,
    keyField: 'Номенклатура_Key',
    keyFields: [...STOCK_SNAPSHOT_KEY_FIELDS],
    oDataPath: stockSnapshotPath(slot.periodLocal),
    select: [...STOCK_SNAPSHOT_KEY_FIELDS, STOCK_SNAPSHOT_QUANTITY_FIELD],
    updatedAtField: null,
    deletedField: null,
    syncMode: 'incremental',
    overlapMinutes: 0,
    pageSize: 1000,
    enabled: slot.enabled,
  };
}

type ConfigurationDocument = Record<string, unknown> & { etlEntities?: unknown };
const entityCodeOf = (entity: unknown): string | null =>
  (entity && typeof entity === 'object' && typeof (entity as { entityCode?: unknown }).entityCode === 'string'
    ? (entity as { entityCode: string }).entityCode : null);

/**
 * The document as the operator works with it: without the managed entities. `managedEntities` tells what was
 * taken out, for display only.
 */
export function operatorProjection<T extends ConfigurationDocument>(document: T): {
  configuration: T; managedEntities: Array<{ entityCode: string; enabled: boolean; oDataPath: string | null }>;
} {
  const entities = Array.isArray(document.etlEntities) ? document.etlEntities : [];
  const managed = entities.filter((entity) => MANAGED_ENTITY_CODES.has(entityCodeOf(entity) ?? ''));
  if (managed.length === 0) return { configuration: document, managedEntities: [] };
  return {
    configuration: { ...document, etlEntities: entities.filter((entity) => !MANAGED_ENTITY_CODES.has(entityCodeOf(entity) ?? '')) },
    managedEntities: managed.map((entity) => {
      const record = entity as { entityCode: string; enabled?: unknown; oDataPath?: unknown };
      return { entityCode: record.entityCode, enabled: record.enabled !== false, oDataPath: typeof record.oDataPath === 'string' ? record.oDataPath : null };
    }),
  };
}

/**
 * The document that goes to the agent: whatever `base` carried under the managed codes is dropped and the set of
 * the slot is appended (last, so the operator's entities keep their order). No slot — snapshots were never
 * requested for the source — no set.
 */
export function withManagedEntities<T extends ConfigurationDocument>(base: T, slot: ManagedStockSlot | null): T {
  const { configuration } = operatorProjection(base);
  if (!slot) return configuration;
  const entities = Array.isArray(configuration.etlEntities) ? configuration.etlEntities : [];
  return { ...configuration, etlEntities: [...entities, managedStockEntity(slot)] };
}

/** Codes of managed entities found in a document an operator sent (a draft must not carry them). */
export function managedCodesIn(document: unknown): string[] {
  const entities = document && typeof document === 'object' && Array.isArray((document as ConfigurationDocument).etlEntities)
    ? (document as { etlEntities: unknown[] }).etlEntities : [];
  return [...new Set(entities.map(entityCodeOf).filter((code): code is string => code !== null && MANAGED_ENTITY_CODES.has(code)))];
}
