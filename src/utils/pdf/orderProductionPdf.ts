import type { OrderExcelDetail, OrderExcelDetailRow } from '../excel/orderExcelBuilder';
import { formatDate, getYearLastTwoDigits } from '../printFormat';

export interface OrderProductionPdfParams {
  order: {
    orderId: number;
    orderName: string;
    orderDate: string | Date;
    clientName?: string | null;
    clientPhone?: string | null;
    prisadkaName?: string | null;
    prisadkaDesignerName?: string | null;
  };
  details: OrderExcelDetailRow[];
}

const isBlankRow = (detail: OrderExcelDetailRow): detail is { kind: 'blank' } => (
  'kind' in detail && detail.kind === 'blank'
);

const roundArea = (detail: OrderExcelDetail): number | null => {
  if (
    detail.length === null
    || detail.width === null
    || !Number.isFinite(detail.length)
    || !Number.isFinite(detail.width)
    || !Number.isFinite(detail.quantity)
  ) {
    return null;
  }

  return Math.round(
    ((detail.length / 1000) * (detail.width / 1000) * detail.quantity) * 100,
  ) / 100;
};

const formatDecimal = (value: number | null, digits = 2): string => (
  value === null
    ? '—'
    : new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
);

const formatExcelCell = (value: string | number | null | undefined): string => (
  value === null || value === undefined || value === '' ? '' : escapeHtml(String(value))
);

const formatExcelDecimal = (value: number | null): string => (
  value === null ? '' : formatDecimal(value)
);

const commonValue = (
  details: readonly OrderExcelDetail[],
  getValue: (detail: OrderExcelDetail) => string | null | undefined,
): string => {
  const values = details.map(getValue).filter((value): value is string => Boolean(value));
  if (values.length === 0 || values.some((value) => value !== values[0])) return '';
  return values[0];
};

export function groupOrderProductionDetailsByFilm(
  details: readonly OrderExcelDetailRow[],
): OrderExcelDetailRow[] {
  const groups = new Map<string, OrderExcelDetail[]>();

  details.forEach((detail) => {
    if (isBlankRow(detail)) return;
    const filmKey = detail.film?.film_name?.trim() || '';
    const group = groups.get(filmKey);
    if (group) {
      group.push(detail);
    } else {
      groups.set(filmKey, [detail]);
    }
  });

  const orderedGroups = [
    ...Array.from(groups.entries()).filter(([key]) => key !== '').map(([, group]) => group),
    ...Array.from(groups.entries()).filter(([key]) => key === '').map(([, group]) => group),
  ];

  return orderedGroups.flatMap((group, index) => (
    index === 0 ? group : [{ kind: 'blank' as const }, ...group]
  ));
}

export function buildOrderProductionPdfDocument({
  order,
  details,
}: OrderProductionPdfParams): string {
  const actualDetails = details.filter((detail): detail is OrderExcelDetail => !isBlankRow(detail));
  const groupedDetails = groupOrderProductionDetailsByFilm(actualDetails);
  const totalArea = actualDetails.reduce((sum, detail) => sum + (roundArea(detail) ?? 0), 0);
  const totalQuantity = actualDetails.reduce((sum, detail) => sum + detail.quantity, 0);
  const orderYear = getYearLastTwoDigits(order.orderDate);
  const documentTitle = `${order.orderName} — PDF для производства`;
  const designer = order.prisadkaDesignerName
    ? `конструктор ${order.prisadkaDesignerName}`
    : null;

  let detailOrdinal = 0;
  const detailRows = groupedDetails.map((detail) => {
    if (isBlankRow(detail)) {
      return '<tr class="detail-separator" aria-hidden="true"><td colspan="13"></td></tr>';
    }

    detailOrdinal += 1;
    return `<tr>
      <td class="number">${detailOrdinal}</td>
      <td class="number">${formatExcelCell(detail.length)}</td>
      <td class="number">${formatExcelCell(detail.width)}</td>
      <td class="number">${formatExcelCell(detail.quantity)}</td>
      <td class="number">${formatExcelDecimal(roundArea(detail))}</td>
      <td>${formatExcelCell(detail.milling_type?.milling_type_name)}</td>
      <td>${formatExcelCell(detail.edge_type?.edge_type_name)}</td>
      <td>${formatExcelCell(detail.notes)}</td>
      <td class="number financial-cell"></td>
      <td class="number financial-cell"></td>
      <td colspan="3">${formatExcelCell(detail.film?.film_name)}</td>
    </tr>`;
  }).join('\n');

  const commonMilling = commonValue(actualDetails, (detail) => detail.milling_type?.milling_type_name);
  const commonEdge = commonValue(actualDetails, (detail) => detail.edge_type?.edge_type_name);
  const commonFilm = commonValue(actualDetails, (detail) => detail.film?.film_name);
  const commonMaterial = commonValue(actualDetails, (detail) => detail.material?.material_name);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="light only" />
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 8mm;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: #fff;
      color: #111;
      font-family: Calibri, Arial, Helvetica, sans-serif;
      font-size: 8pt;
      line-height: 1.15;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    table {
      border-collapse: collapse;
      table-layout: fixed;
      width: 100%;
    }
    .excel-order-header {
      margin-bottom: 2.25pt;
    }
    .excel-order-header th,
    .excel-order-header td {
      border: 1px solid #444;
      padding: 0 2px;
      text-align: center;
      vertical-align: middle;
    }
    .excel-order-header .excel-top-cell { border: 0; }
    .excel-order-header .excel-bottom-rule { border-bottom: 1px solid #444; }
    .excel-header-row-1 { height: 13.15pt; }
    .excel-header-row-2 { height: 13.15pt; }
    .excel-header-row-3 { height: 13.15pt; }
    .excel-header-row-4 { height: 12pt; }
    .excel-header-row-5 { height: 12pt; }
    .excel-header-row-6 { height: 12pt; }
    .excel-header-row-7 { height: 12pt; }
    .excel-header-row-8 { height: 13.15pt; }
    .excel-header-row-9 { height: 12.75pt; }
    .excel-order-year {
      font-size: 10pt;
      text-align: right;
    }
    .excel-order-header .excel-order-name {
      font-size: 16pt;
      font-weight: 700;
      line-height: 1;
    }
    .excel-prisadka-label { font-size: 6pt; font-weight: 400; text-align: left; }
    .excel-client-label { font-size: 12pt; font-weight: 700; }
    .excel-financial-label { font-size: 11pt; font-weight: 400; }
    .excel-top-value { font-size: 14pt; font-weight: 700; }
    .excel-financial-value { font-size: 12pt; font-weight: 700; }
    .excel-section-label { font-size: 11pt; font-weight: 400; }
    .excel-section-value {
      font-size: 12pt;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .excel-summary-label { font-size: 9pt; font-weight: 400; }
    .excel-date-label { font-size: 10pt; font-weight: 700; }
    .excel-date-value { font-size: 11pt; font-weight: 700; }
    .excel-designer-value { font-size: 10pt; font-weight: 700; }
    .excel-phone-value { font-family: Arial, Helvetica, sans-serif; font-size: 14pt; font-weight: 700; }
    .excel-summary-value { font-size: 12pt; font-weight: 700; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td {
      background: #fff;
      border: 1px solid #555;
      padding: 3px 4px;
      vertical-align: middle;
    }
    th {
      font-size: 8px;
      font-weight: 700;
      text-align: center;
    }
    .excel-detail-table thead th { height: 44px; }
    .excel-detail-table tbody td { height: 19px; }
    td {
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .number {
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap;
    }
    .detail-separator td {
      height: 19px;
      padding: 0;
    }
    col:nth-child(1) { width: 3.06%; }
    col:nth-child(2) { width: 6.48%; }
    col:nth-child(3) { width: 6.36%; }
    col:nth-child(4) { width: 5.53%; }
    col:nth-child(5) { width: 4.36%; }
    col:nth-child(6) { width: 15.79%; }
    col:nth-child(7) { width: 4.36%; }
    col:nth-child(8) { width: 18.73%; }
    col:nth-child(9) { width: 6.83%; }
    col:nth-child(10) { width: 10.96%; }
    col:nth-child(11) { width: 7.66%; }
    col:nth-child(12) { width: 6.83%; }
    col:nth-child(13) { width: 3.05%; }
  </style>
</head>
<body>
  <header>
    <table class="excel-order-header" aria-label="Шапка заказа">
      <colgroup>${'<col />'.repeat(13)}</colgroup>
      <tbody>
        <tr class="excel-header-row-1">
          <td data-excel-range="A1" class="excel-order-year excel-top-cell">${escapeHtml(orderYear)}</td>
          <td data-excel-range="B1" class="excel-top-cell"></td>
          <td data-excel-range="C1:C3" class="excel-order-name excel-top-cell excel-bottom-rule" rowspan="3">${formatExcelCell(order.orderName)}</td>
          <th data-excel-range="D1" class="excel-prisadka-label excel-top-cell" scope="row">№ присадки</th>
          <th data-excel-range="E1:I1" class="excel-client-label excel-top-cell" colspan="5" scope="row">Заказчик</th>
          <th data-excel-range="J1:K1" class="excel-financial-label excel-top-cell" colspan="2" scope="row">общая сумма</th>
          <th data-excel-range="L1:M1" class="excel-financial-label excel-top-cell" colspan="2" scope="row">скидка</th>
        </tr>
        <tr class="excel-header-row-2">
          <td data-excel-range="A2" class="excel-top-cell"></td>
          <td data-excel-range="B2" class="excel-top-cell"></td>
          <td data-excel-range="D2:D3" class="excel-top-value excel-top-cell excel-bottom-rule" rowspan="2">${formatExcelCell(order.prisadkaName)}</td>
          <td data-excel-range="E2:I3" class="excel-top-value excel-top-cell" colspan="5" rowspan="2">${formatExcelCell(order.clientName)}</td>
          <td data-excel-range="J2:K3" class="excel-financial-value excel-top-cell" colspan="2" rowspan="2" data-field="total-amount"></td>
          <td data-excel-range="L2:M3" class="excel-financial-value excel-top-cell" colspan="2" rowspan="2" data-field="discount"></td>
        </tr>
        <tr class="excel-header-row-3">
          <td data-excel-range="A3" class="excel-top-cell"></td>
          <td data-excel-range="B3" class="excel-top-cell"></td>
        </tr>
        <tr class="excel-header-row-4">
          <th data-excel-range="A4:C4" class="excel-section-label" colspan="3" scope="row">фрезеровка</th>
          <th data-excel-range="D4:E4" class="excel-section-label" colspan="2" scope="row">обкат</th>
          <th data-excel-range="F4:G4" class="excel-section-label" colspan="2" scope="row">пленка</th>
          <td data-excel-range="H4:I4" class="excel-section-label" colspan="2"></td>
          <th data-excel-range="J4:J5" class="excel-summary-label" rowspan="2" scope="row">остаток оплаты</th>
          <td data-excel-range="K4:M5" class="excel-financial-value" colspan="3" rowspan="2" data-field="outstanding"></td>
        </tr>
        <tr class="excel-header-row-5">
          <td data-excel-range="A5:C7" class="excel-section-value" colspan="3" rowspan="3">${formatExcelCell(commonMilling)}</td>
          <td data-excel-range="D5:E7" class="excel-section-value" colspan="2" rowspan="3">${formatExcelCell(commonEdge)}</td>
          <td data-excel-range="F5:G7" class="excel-section-value" colspan="2" rowspan="3">${formatExcelCell(commonFilm)}</td>
          <td data-excel-range="H5:H7" class="excel-section-value" rowspan="3">${formatExcelCell(commonMaterial)}</td>
          <td data-excel-range="I5:I7" class="excel-section-value" rowspan="3"></td>
        </tr>
        <tr class="excel-header-row-6">
          <th data-excel-range="J6:J7" class="excel-summary-label" rowspan="2" scope="row">срок выполнения</th>
          <td data-excel-range="K6:M7" class="excel-section-value" colspan="3" rowspan="2"></td>
        </tr>
        <tr class="excel-header-row-7"></tr>
        <tr class="excel-header-row-8">
          <th data-excel-range="A8:B9" class="excel-date-label" colspan="2" rowspan="2" scope="row">Дата</th>
          <td data-excel-range="C8:E9" class="excel-date-value" colspan="3" rowspan="2">${formatExcelCell(formatDate(order.orderDate))}</td>
          <td data-excel-range="F8:F9" class="excel-designer-value" rowspan="2">${formatExcelCell(designer)}</td>
          <td data-excel-range="G8:G9" rowspan="2"></td>
          <td data-excel-range="H8:I9" class="excel-phone-value" colspan="2" rowspan="2">${formatExcelCell(order.clientPhone)}</td>
          <th data-excel-range="J8:J9" class="excel-summary-label" rowspan="2" scope="row">общая площадь</th>
          <td data-excel-range="K8:K9" class="excel-summary-value number" rowspan="2">${formatDecimal(totalArea)}</td>
          <th data-excel-range="L8:L9" class="excel-summary-label" rowspan="2" scope="row">кол-во деталей</th>
          <td data-excel-range="M8:M9" class="excel-summary-value number" rowspan="2">${formatExcelCell(totalQuantity)}</td>
        </tr>
        <tr class="excel-header-row-9"></tr>
      </tbody>
    </table>
  </header>
  <main>
    <table class="excel-detail-table" aria-label="Детали заказа для производства">
      <colgroup>${'<col />'.repeat(13)}</colgroup>
      <thead>
        <tr>
          <th scope="col">№</th>
          <th scope="col">Высота</th>
          <th scope="col">Ширина</th>
          <th scope="col">Кол-во</th>
          <th scope="col">Площадь</th>
          <th scope="col">Тип детали</th>
          <th scope="col">Обкат</th>
          <th scope="col">Примечание</th>
          <th scope="col">Цена за кв.м.</th>
          <th scope="col">Сумма</th>
          <th scope="col" colspan="3">Пленка</th>
        </tr>
      </thead>
      <tbody>${detailRows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

export function openOrderProductionPdfPreview(params: OrderProductionPdfParams): boolean {
  if (
    typeof document === 'undefined'
    || typeof window === 'undefined'
    || params.details.every(isBlankRow)
  ) {
    return false;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'PDF для производства');
  iframe.style.border = '0';
  iframe.style.height = '0';
  iframe.style.opacity = '0';
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  document.body.appendChild(iframe);

  const frameWindow = iframe.contentWindow;
  const frameDocument = iframe.contentDocument ?? frameWindow?.document ?? null;
  if (!frameWindow || !frameDocument) {
    iframe.remove();
    return false;
  }

  let cleanupTimer: number | undefined;
  const cleanup = () => {
    if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
    iframe.remove();
  };

  frameWindow.addEventListener('afterprint', cleanup, { once: true });
  cleanupTimer = window.setTimeout(cleanup, 120_000);
  frameDocument.open();
  frameDocument.write(buildOrderProductionPdfDocument(params));
  frameDocument.close();

  window.setTimeout(() => {
    try {
      frameWindow.focus();
      frameWindow.print();
    } catch {
      cleanup();
    }
  }, 100);

  return true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
