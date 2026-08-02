import type { OrderResourceDemandDto } from '../../api/types/orderApi.types';

export type ResourceDemandReportMaterial = 'films' | 'sheetMaterials';
export type ResourceDemandReportFormat = 'brief' | 'detailed';
export type ResourceDemandReportFileFormat = 'xls' | 'csv' | 'txt';
export type ResourceDemandReportColumnKey =
  | 'orderNumber'
  | 'clientName'
  | 'orderDateText'
  | 'materialName'
  | 'quantityText'
  | 'unit';

export interface ResourceDemandReportColumn {
  key: ResourceDemandReportColumnKey;
  title: string;
}

export interface ResourceDemandReportRow {
  orderNumber: string;
  clientName: string;
  orderDateText: string;
  materialName: string;
  quantityText: string;
  unit: string;
}

export interface ResourceDemandReportGroup {
  providerName: string;
  rows: ResourceDemandReportRow[];
}

export interface ResourceDemandReport {
  material: ResourceDemandReportMaterial;
  reportFormat: ResourceDemandReportFormat;
  fileFormat: ResourceDemandReportFileFormat;
  title: string;
  subtitle: string;
  columns: ResourceDemandReportColumn[];
  groups: ResourceDemandReportGroup[];
  content: string;
  fileName: string;
  mimeType: string;
}

export interface BuildResourceDemandReportInput {
  rows: OrderResourceDemandDto[];
  material: ResourceDemandReportMaterial;
  reportFormat: ResourceDemandReportFormat;
  fileFormat: ResourceDemandReportFileFormat;
  generatedAt: Date;
}

interface ReportLineItem extends ResourceDemandReportRow {
  providerName: string;
}

const quantityFormatter = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 1,
});

const reportDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'long',
});

export function buildResourceDemandReport(input: BuildResourceDemandReportInput): ResourceDemandReport {
  const title = `${reportDateFormatter.format(input.generatedAt)} - ${reportTitleSuffix(input.material)}`;
  const subtitle = reportSubtitle(input.material);
  const columns = reportColumns(input.reportFormat);
  const groups = groupReportRows(flattenReportRows(input.rows, input.material));
  const fileName = reportFileName(input);
  const mimeType = reportMimeType(input.fileFormat);
  const content = reportContent({
    title,
    subtitle,
    groups,
    columns,
    reportFormat: input.reportFormat,
    fileFormat: input.fileFormat,
  });

  return {
    material: input.material,
    reportFormat: input.reportFormat,
    fileFormat: input.fileFormat,
    title,
    subtitle,
    columns,
    groups,
    content,
    fileName,
    mimeType,
  };
}

function flattenReportRows(rows: OrderResourceDemandDto[], material: ResourceDemandReportMaterial): ReportLineItem[] {
  return rows.flatMap((row) => {
    const orderNumber = orderDisplayNumber(row);
    const clientName = row.clientName?.trim() || 'Клиент не указан';
    const orderDateText = formatDateOnly(row.orderDate);

    if (material === 'sheetMaterials') {
      return row.sheetMaterials.map((sheet) => ({
        providerName: sheet.supplierName?.trim() || 'Без поставщика',
        orderNumber,
        clientName,
        orderDateText,
        materialName: sheet.name,
        quantityText: quantityFormatter.format(sheet.totalArea),
        unit: 'м²',
      }));
    }

    return row.films.map((film) => ({
      providerName: film.vendorName?.trim() || 'Без производителя',
      orderNumber,
      clientName,
      orderDateText,
      materialName: film.name,
      quantityText: quantityFormatter.format(film.linearMeters),
      unit: 'пог. м',
    }));
  });
}

function groupReportRows(items: ReportLineItem[]): ResourceDemandReportGroup[] {
  const groups = new Map<string, ResourceDemandReportGroup>();
  for (const item of items) {
    const group = groups.get(item.providerName) ?? { providerName: item.providerName, rows: [] };
    group.rows.push({
      orderNumber: item.orderNumber,
      clientName: item.clientName,
      orderDateText: item.orderDateText,
      materialName: item.materialName,
      quantityText: item.quantityText,
      unit: item.unit,
    });
    groups.set(item.providerName, group);
  }

  return [...groups.values()]
    .sort((left, right) => compareText(left.providerName, right.providerName))
    .map((group) => ({
      ...group,
      rows: group.rows.sort(
        (left, right) =>
          compareText(left.orderNumber, right.orderNumber) ||
          compareText(left.materialName, right.materialName),
      ),
    }));
}

function reportContent(input: {
  title: string;
  subtitle: string;
  groups: ResourceDemandReportGroup[];
  columns: ResourceDemandReportColumn[];
  reportFormat: ResourceDemandReportFormat;
  fileFormat: ResourceDemandReportFileFormat;
}): string {
  if (input.fileFormat === 'csv') return csvReport(input);
  if (input.fileFormat === 'xls') return xlsReport(input);
  return textReport(input);
}

function textReport(input: {
  title: string;
  subtitle: string;
  groups: ResourceDemandReportGroup[];
  reportFormat: ResourceDemandReportFormat;
}): string {
  const lines = [input.title, '', input.subtitle, ''];

  if (input.groups.length === 0) {
    lines.push('Нет данных для отчета');
    return lines.join('\n');
  }

  for (const group of input.groups) {
    lines.push(group.providerName);
    for (const row of group.rows) {
      lines.push(textReportRow(row, input.reportFormat));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function textReportRow(row: ResourceDemandReportRow, reportFormat: ResourceDemandReportFormat): string {
  const base = `${row.orderNumber}-${row.materialName} - ${row.quantityText}`;
  if (reportFormat === 'brief') return base;
  return `${base} ${row.unit} - ${row.clientName} - ${row.orderDateText}`;
}

function csvReport(input: {
  title: string;
  subtitle: string;
  groups: ResourceDemandReportGroup[];
  columns: ResourceDemandReportColumn[];
}): string {
  const columns = [{ key: 'providerName', title: 'Поставщик' }, ...input.columns] as const;
  const lines = [
    [input.title],
    [],
    [input.subtitle],
    [],
    columns.map((column) => column.title),
  ];

  for (const group of input.groups) {
    for (const row of group.rows) {
      lines.push(columns.map((column) => {
        if (column.key === 'providerName') return group.providerName;
        return row[column.key];
      }));
    }
  }

  if (input.groups.length === 0) lines.push(['Нет данных для отчета']);
  return lines.map((line) => line.map(csvEscape).join(';')).join('\n');
}

function xlsReport(input: {
  title: string;
  subtitle: string;
  groups: ResourceDemandReportGroup[];
  columns: ResourceDemandReportColumn[];
}): string {
  const colspan = input.columns.length;
  const bodyRows = input.groups.length === 0
    ? `<tr><td colspan="${colspan}">Нет данных для отчета</td></tr>`
    : input.groups.map((group) => `
      <tr><th colspan="${colspan}" style="text-align:left;background:#f2f2f2">${escapeHtml(group.providerName)}</th></tr>
      <tr>${input.columns.map((column) => `<th>${escapeHtml(column.title)}</th>`).join('')}</tr>
      ${group.rows.map((row) => `
        <tr>${input.columns.map((column) => `<td>${escapeHtml(row[column.key])}</td>`).join('')}</tr>
      `).join('')}
    `).join('');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<table border="1">
  <tr><th colspan="${colspan}" style="text-align:left">${escapeHtml(input.title)}</th></tr>
  <tr><td colspan="${colspan}">${escapeHtml(input.subtitle)}</td></tr>
  <tr><td colspan="${colspan}"></td></tr>
  ${bodyRows}
</table>
</body>
</html>`;
}

function reportColumns(reportFormat: ResourceDemandReportFormat): ResourceDemandReportColumn[] {
  if (reportFormat === 'brief') {
    return [
      { key: 'orderNumber', title: 'Заказ' },
      { key: 'materialName', title: 'Название' },
      { key: 'quantityText', title: 'Количество' },
    ];
  }

  return [
    { key: 'orderNumber', title: 'Заказ' },
    { key: 'clientName', title: 'Клиент' },
    { key: 'orderDateText', title: 'Дата заказа' },
    { key: 'materialName', title: 'Название' },
    { key: 'quantityText', title: 'Количество' },
    { key: 'unit', title: 'Ед.' },
  ];
}

function reportTitleSuffix(material: ResourceDemandReportMaterial): string {
  return material === 'films'
    ? 'список пленок для заказа'
    : 'список листовых материалов для заказа';
}

function reportSubtitle(material: ResourceDemandReportMaterial): string {
  return material === 'films' ? 'Бүгін алатын пленкалар' : 'Бүгін алатын материалдар';
}

function reportFileName(input: BuildResourceDemandReportInput): string {
  const date = input.generatedAt.toISOString().slice(0, 10);
  const material = input.material === 'films' ? 'films' : 'sheet-materials';
  return `order-resource-demands-${material}-${input.reportFormat}-${date}.${input.fileFormat}`;
}

function reportMimeType(fileFormat: ResourceDemandReportFileFormat): string {
  if (fileFormat === 'xls') return 'application/vnd.ms-excel;charset=utf-8';
  if (fileFormat === 'csv') return 'text/csv;charset=utf-8';
  return 'text/plain;charset=utf-8';
}

function orderDisplayNumber(row: Pick<OrderResourceDemandDto, 'orderId' | 'orderName'>): string {
  return row.orderName?.trim() || `#${row.orderId}`;
}

function formatDateOnly(value: string | null): string {
  if (!value) return 'без даты';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' });
}

function csvEscape(value: string): string {
  if (!/[;"\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
