import { describe, expect, it } from 'vitest';
import type { OrderResourceDemandDto } from '../../api/types/orderApi.types';
import { buildResourceDemandReport } from './resourceDemandReport';

const generatedAt = new Date('2026-08-02T10:00:00.000Z');

const rows: OrderResourceDemandDto[] = [
  {
    orderId: 1,
    orderName: '2712',
    fullNumber: 'PRJ-2712',
    orderDate: '2026-08-01',
    projectCode: 'PRJ',
    clientName: 'Алия',
    updatedAt: '2026-08-02T09:00:00.000Z',
    sheetMaterials: [
      {
        sheetMaterialTypeId: 10,
        name: 'МДФ 18',
        totalArea: 12.35,
        detailsCount: 4,
        supplierId: 7,
        supplierName: 'ЛистПоставка',
      },
    ],
    films: [
      {
        filmId: 20,
        name: 'Слоновая кость',
        totalArea: 1.2,
        detailsCount: 2,
        linearMeters: 5.2,
        sheets: 1,
        hasCutData: true,
        vendorId: 3,
        vendorName: 'Фокус прайм',
      },
    ],
  },
  {
    orderId: 2,
    orderName: '2717',
    fullNumber: 'PRJ-2717',
    orderDate: '2026-08-02',
    projectCode: 'PRJ',
    clientName: 'Руслан',
    updatedAt: '2026-08-02T09:10:00.000Z',
    sheetMaterials: [],
    films: [
      {
        filmId: 21,
        name: 'Олива JS9060',
        totalArea: 1.4,
        detailsCount: 2,
        linearMeters: 6.2,
        sheets: 1,
        hasCutData: true,
        vendorId: 4,
        vendorName: 'Кира',
      },
    ],
  },
];

describe('buildResourceDemandReport', () => {
  it('строит краткий TXT-отчет по пленкам в формате примера', () => {
    const report = buildResourceDemandReport({
      rows,
      material: 'films',
      reportFormat: 'brief',
      fileFormat: 'txt',
      generatedAt,
    });

    expect(report.content).toContain('02 августа - список пленок для заказа');
    expect(report.content).toContain('Бүгін алатын пленкалар');
    expect(report.content).toContain('Фокус прайм\n2712-Слоновая кость - 5,2');
    expect(report.content).toContain('Кира\n2717-Олива JS9060 - 6,2');
    expect(report.content).not.toContain('PRJ-2712');
  });

  it('в подробном отчете добавляет клиента, дату заказа и единицы', () => {
    const report = buildResourceDemandReport({
      rows,
      material: 'films',
      reportFormat: 'detailed',
      fileFormat: 'txt',
      generatedAt,
    });

    expect(report.content).toContain('2712-Слоновая кость - 5,2 пог. м - Алия - 01.08.2026');
  });

  it('строит CSV и XLS для выбранного материала', () => {
    const csv = buildResourceDemandReport({
      rows,
      material: 'sheetMaterials',
      reportFormat: 'brief',
      fileFormat: 'csv',
      generatedAt,
    });
    const xls = buildResourceDemandReport({
      rows,
      material: 'sheetMaterials',
      reportFormat: 'brief',
      fileFormat: 'xls',
      generatedAt,
    });

    expect(csv.content).toContain('ЛистПоставка;2712;МДФ 18;12,4');
    expect(xls.content).toContain('<table border="1">');
    expect(xls.content).toContain('ЛистПоставка');
  });
});
