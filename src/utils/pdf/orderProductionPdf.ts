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
  const orderNumber = `Ф${getYearLastTwoDigits(order.orderDate)}-${order.orderId}`;
  const documentTitle = `Заказ ${orderNumber} — PDF для производства`;
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
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8px;
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
      margin-bottom: 3px;
    }
    .excel-order-header th,
    .excel-order-header td {
      border: 1px solid #444;
      height: 17px;
      padding: 2px 4px;
      text-align: center;
    }
    .excel-order-header th {
      font-size: 7px;
      font-weight: 700;
      text-transform: lowercase;
    }
    .excel-order-header .excel-order-number {
      font-size: 12px;
      font-weight: 700;
    }
    .excel-order-header .excel-order-name {
      font-size: 11px;
      font-weight: 700;
    }
    .excel-order-header .excel-value {
      font-size: 9px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
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
        <tr>
          <td class="excel-order-number" colspan="2" rowspan="3">Заказ ${escapeHtml(orderNumber)}</td>
          <td class="excel-order-name" rowspan="3">${formatExcelCell(order.orderName)}</td>
          <th scope="row">№ присадки</th>
          <th colspan="5" scope="row">Заказчик</th>
          <th colspan="2" scope="row">Общая сумма</th>
          <th colspan="2" scope="row">Скидка</th>
        </tr>
        <tr>
          <td class="excel-value" rowspan="2">${formatExcelCell(order.prisadkaName)}</td>
          <td class="excel-value" colspan="5" rowspan="2">${formatExcelCell(order.clientName)}</td>
          <td class="excel-value financial-value" colspan="2" rowspan="2" data-field="total-amount"></td>
          <td class="excel-value financial-value" colspan="2" rowspan="2" data-field="discount"></td>
        </tr>
        <tr></tr>
        <tr>
          <th colspan="3" scope="row">Фрезеровка</th>
          <th colspan="2" scope="row">Обкат</th>
          <th colspan="2" scope="row">Пленка</th>
          <th colspan="2" scope="row">Материал</th>
          <th rowspan="2" scope="row">Остаток оплаты</th>
          <td class="excel-value financial-value" colspan="3" rowspan="2" data-field="outstanding"></td>
        </tr>
        <tr>
          <td class="excel-value" colspan="3" rowspan="3">${formatExcelCell(commonMilling)}</td>
          <td class="excel-value" colspan="2" rowspan="3">${formatExcelCell(commonEdge)}</td>
          <td class="excel-value" colspan="2" rowspan="3">${formatExcelCell(commonFilm)}</td>
          <td class="excel-value" colspan="2" rowspan="3">${formatExcelCell(commonMaterial)}</td>
        </tr>
        <tr>
          <th rowspan="2" scope="row">Срок выполнения</th>
          <td class="excel-value" colspan="3" rowspan="2"></td>
        </tr>
        <tr></tr>
        <tr>
          <th colspan="2" rowspan="2" scope="row">Дата</th>
          <td class="excel-value" colspan="3" rowspan="2">${formatExcelCell(formatDate(order.orderDate))}</td>
          <td class="excel-value" colspan="2" rowspan="2">${formatExcelCell(designer)}</td>
          <td class="excel-value" colspan="2" rowspan="2">${formatExcelCell(order.clientPhone)}</td>
          <th rowspan="2" scope="row">Общая площадь</th>
          <td class="excel-value number" rowspan="2">${formatDecimal(totalArea)}</td>
          <th rowspan="2" scope="row">Кол-во деталей</th>
          <td class="excel-value number" rowspan="2">${formatExcelCell(totalQuantity)}</td>
        </tr>
        <tr></tr>
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
