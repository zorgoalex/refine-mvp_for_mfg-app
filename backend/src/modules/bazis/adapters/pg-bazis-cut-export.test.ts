import * as XLSX from 'xlsx';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgBazisRepository } from './pg-bazis-repository';

describe('PgBazisRepository.exportCutXls', () => {
  it('maps selected Bazis panels through the ERP-order fields and writes audited BIFF8 XLS', async () => {
    const query = vi.fn(async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM bazis_project_revisions r') && sql.includes('JOIN bazis_projects bp')) {
        return rows([{
          bazis_revision_id: 12,
          bazis_project_id: 7,
          project_id: 77,
          bazis_project_name: 'Кухня тест',
          revision_bazis_order_no: 'BP-7',
          project_client_id: 5,
          client_name: 'Тест Клиент',
        }]);
      }
      if (sql.startsWith('SELECT bazis_node_id, object_type FROM bazis_nodes')) {
        return rows([
          { bazis_node_id: 101, object_type: 'Панель' },
          { bazis_node_id: 102, object_type: 'Панель' },
        ]);
      }
      if (sql.startsWith('WITH RECURSIVE sel AS')) {
        return rows([
          panelRow(101, 'Кухня', '01.00.01', 'Вертикальная', 2),
          panelRow(102, 'Шкаф', '02.00.01', null, 1),
        ]);
      }
      if (sql.includes('FROM bazis_material_mappings')) {
        return rows([
          {
            source_kind: 'sheet',
            name: 'лдсп белый',
            target_kind: 'sheet',
            sheet_material_type_id: 3,
            film_id: null,
            edge_type_id: null,
          },
          {
            source_kind: 'film',
            name: 'пвх белая',
            target_kind: 'film',
            sheet_material_type_id: null,
            film_id: 9,
            edge_type_id: null,
          },
        ]);
      }
      if (sql.includes("SELECT 'milling'::text AS reference_kind") && !sql.includes("SELECT 'sheet'::text")) {
        return rows([
          { reference_kind: 'milling', reference_id: 4, name: 'модерн' },
          { reference_kind: 'film', reference_id: 9, name: 'пвх белая' },
        ]);
      }
      if (sql.startsWith('SELECT COUNT(*)::int AS root_product_count')) {
        return rows([{ root_product_count: 2 }]);
      }
      if (sql.includes("SELECT 'sheet'::text AS reference_kind")) {
        expect(params).toEqual([[3], [4], [9]]);
        return rows([
          { reference_kind: 'sheet', reference_id: 3, reference_name: 'ЛДСП Белый', thickness_mm: 16 },
          { reference_kind: 'milling', reference_id: 4, reference_name: 'Модерн', thickness_mm: null },
          { reference_kind: 'film', reference_id: 9, reference_name: 'ПВХ белая', thickness_mm: null },
        ]);
      }
      if (sql === 'SELECT set_session_user($1)') return rows([]);
      if (sql.startsWith('INSERT INTO audit_log (')) return rows([{ audit_id: 'audit-export-1' }]);
      if (sql.startsWith('INSERT INTO audit_log_related_entity')) return rows([]);
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = vi.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query }));
    const repository = new PgBazisRepository({ query, transaction } as unknown as DatabaseService);

    const result = await repository.exportCutXls({
      currentUser: user(),
      requestId: 'req-export',
      revisionId: 12,
      selectedNodeIds: [102, 101],
    });

    expect(result).toMatchObject({
      bazisProjectId: 7,
      bazisProjectName: 'Кухня тест',
      revisionId: 12,
      positionCount: 2,
      quantity: 3,
    });
    expect(result.bytes.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
    const workbook = XLSX.read(result.bytes, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]]!;
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    expect(data[1]?.slice(0, 15)).toEqual([
      'Да', 'Площадной', 'ЛДСП Белый', '', 16, 'BP-7', 'Кухня', 'BP-7Кухня.01.00.01',
      'BP-7Кухня.01.00.01', 'Панель 101', 500, 1000, 500, 1000, 2,
    ]);
    expect(data[1]?.slice(33, 37)).toEqual(['Модерн', 'Присадка:', '', 'ПВХ белая']);
    expect(data[2]?.[7]).toBe('BP-7Шкаф.02.00.01');
    const auditCall = query.mock.calls.find(([text]) => String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('));
    expect(auditCall?.[1]?.[0]).toBe('bazis.cut_xls_exported');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

function panelRow(
  id: number,
  productName: string,
  designation: string,
  textureOrientation: string | null,
  quantity: number,
) {
  return {
    bazis_node_id: id,
    object_type: 'Панель',
    name: `Панель ${id}`,
    position: designation,
    designation,
    cumulative_quantity: quantity,
    length_mm: 1000,
    width_mm: 500,
    texture_orientation: textureOrientation,
    main_material_name: 'ЛДСП Белый',
    product_name: productName,
    product_order_no: `ORDER-${id}`,
    raw_json: {
      Отверстие: [{}],
      ПользовательскиеСвойства: {
        Свойство: [
          { Имя: 'Фрезировка', Значение: 'Модерн' },
          { Имя: 'Пленка', Значение: 'ПВХ белая' },
        ],
      },
    },
  };
}

function rows<T>(items: T[]) {
  return { rows: items, rowCount: items.length };
}

function user(): CurrentUser {
  return {
    id: '10',
    username: 'manager',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.view', 'cut.view'],
  };
}
