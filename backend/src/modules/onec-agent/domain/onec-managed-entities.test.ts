import { describe, expect, it } from 'vitest';
import { ODATA_PATH_PATTERN, onecEtlEntitySchema, validateOnecConfiguration } from './onec-config';
import { SNAPSHOT_ENTITIES } from './onec-etl';
import {
  MANAGED_ENTITY_CODES, STOCK_SNAPSHOT_ENTITY_CODE, managedCodesIn, managedStockEntity, operatorProjection, stockSnapshotPath, withManagedEntities,
} from './onec-managed-entities';

const items = { entityCode: 'items', oDataPath: 'Catalog_Номенклатура', keyField: 'Ref_Key', select: ['Ref_Key'], syncMode: 'incremental', pageSize: 100, overlapMinutes: 0 };
const document = (entities: unknown[]) => ({ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: entities });

describe('balances as of a moment in the path', () => {
  it('accepts only the strict form: Period before Dimensions, a full local date-time literal', () => {
    const dims = "Dimensions='Организация,Номенклатура'";
    expect(ODATA_PATH_PATTERN.test(`AccumulationRegister_ЗапасыНаСкладах/Balance(Period=datetime'2026-09-26T10:14:00',${dims})`)).toBe(true);
    expect(ODATA_PATH_PATTERN.test(`AccumulationRegister_ЗапасыНаСкладах/Balance(${dims})`)).toBe(true);
    for (const bad of [
      `X/Balance(${dims},Period=datetime'2026-09-26T10:14:00')`,
      `X/Balance(Period=datetime'2026-09-26',${dims})`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00Z',${dims})`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00+05:00',${dims})`,
      `X/Balance(Period='2026-09-26T10:14:00',${dims})`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00')`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00',Period=datetime'2026-09-27T10:14:00',${dims})`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00',${dims})?$filter=1`,
      `X/Balance(Period=datetime'2026-09-26T10:14:00', ${dims})`,
      `X/Balance(EndPeriod=datetime'2026-09-26T10:14:00',${dims})`,
    ]) expect(ODATA_PATH_PATTERN.test(bad), bad).toBe(false);
  });

  it('the service set is the stock register with the moment, valid for the agent schema, and a snapshot set', () => {
    expect(stockSnapshotPath('2026-09-26T10:14:00')).toBe(
      "AccumulationRegister_ЗапасыНаСкладах/Balance(Period=datetime'2026-09-26T10:14:00',Dimensions='Организация,Номенклатура,Характеристика,Партия,СтруктурнаяЕдиница,Ячейка')");
    expect(() => stockSnapshotPath("2026-09-26T10:14:00',X='")).toThrow();
    expect(() => stockSnapshotPath('2026-09-26 10:14:00')).toThrow();
    for (const enabled of [true, false]) {
      const entity = managedStockEntity({ enabled, periodLocal: '2026-09-26T10:14:00' });
      expect(onecEtlEntitySchema.safeParse(entity).success).toBe(true);
      expect(entity).toMatchObject({ entityCode: 'stock_balances_at', enabled, keyField: 'Номенклатура_Key', updatedAtField: null, deletedField: null, pageSize: 1000 });
      expect(entity.select).toEqual(['Организация_Key', 'Номенклатура_Key', 'Характеристика_Key', 'Партия_Key', 'СтруктурнаяЕдиница_Key', 'Ячейка_Key', 'КоличествоBalance']);
    }
    expect(SNAPSHOT_ENTITIES.has(STOCK_SNAPSHOT_ENTITY_CODE)).toBe(true);
    expect([...MANAGED_ENTITY_CODES]).toEqual(['stock_balances_at']);
  });
});

describe('managed entities of the configuration', () => {
  const slot = { enabled: true, periodLocal: '2026-09-26T10:14:00' };

  it('an operator document must not carry a managed entity', () => {
    expect(validateOnecConfiguration(document([items])).ok).toBe(true);
    const refused = validateOnecConfiguration(document([items, { ...items, entityCode: 'stock_balances_at' }]));
    expect(refused).toEqual({ ok: false, issues: [{ path: 'etlEntities.1.entityCode', message: 'stock_balances_at is a service entity managed by ERP and cannot be edited' }] });
    expect(managedCodesIn(document([items]))).toEqual([]);
    expect(managedCodesIn(null)).toEqual([]);
  });

  it('every outgoing document takes the set from the slot, whatever the base carried', () => {
    const forged = { ...items, entityCode: 'stock_balances_at', oDataPath: 'Catalog_Чужое' };
    expect(withManagedEntities(document([items]), null).etlEntities).toEqual([items]);
    // The base came from a published version (revoke, rebaseline) or from a forged draft: the ERP state wins.
    expect(withManagedEntities(document([forged, items]), slot).etlEntities).toEqual([items, managedStockEntity(slot)]);
    expect(withManagedEntities(document([items, managedStockEntity(slot)]), { ...slot, enabled: false }).etlEntities)
      .toEqual([items, managedStockEntity({ ...slot, enabled: false })]);
    expect(withManagedEntities(document([forged, items]), null).etlEntities).toEqual([items]);
    // Idempotent: applying it twice gives the same document (the hash of an unchanged state does not move).
    const once = withManagedEntities(document([items]), slot);
    expect(withManagedEntities(once, slot)).toEqual(once);
  });

  it('the operator projection hides the set and reports it', () => {
    const published = withManagedEntities(document([items]), { ...slot, enabled: false });
    const view = operatorProjection(published);
    expect(view.configuration.etlEntities).toEqual([items]);
    expect(view.managedEntities).toEqual([{ entityCode: 'stock_balances_at', enabled: false, oDataPath: stockSnapshotPath(slot.periodLocal) }]);
    // What the operator sees is a valid operator document again.
    expect(validateOnecConfiguration(view.configuration).ok).toBe(true);
    const plain = document([items]);
    expect(operatorProjection(plain)).toEqual({ configuration: plain, managedEntities: [] });
  });
});
