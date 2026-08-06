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

const formatCell = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  return escapeHtml(String(value));
};

const commonValue = (
  details: readonly OrderExcelDetail[],
  getValue: (detail: OrderExcelDetail) => string | null | undefined,
): string => {
  const values = details.map(getValue).filter((value): value is string => Boolean(value));
  if (values.length === 0 || values.some((value) => value !== values[0])) return '—';
  return values[0];
};

export function buildOrderProductionPdfDocument({
  order,
  details,
}: OrderProductionPdfParams): string {
  const actualDetails = details.filter((detail): detail is OrderExcelDetail => !isBlankRow(detail));
  const totalArea = actualDetails.reduce((sum, detail) => sum + (roundArea(detail) ?? 0), 0);
  const totalQuantity = actualDetails.reduce((sum, detail) => sum + detail.quantity, 0);
  const orderNumber = `Ф${getYearLastTwoDigits(order.orderDate)}-${order.orderId}`;
  const documentTitle = `Заказ ${orderNumber} — PDF для производства`;
  const designer = order.prisadkaDesignerName
    ? `конструктор ${order.prisadkaDesignerName}`
    : null;

  let detailOrdinal = 0;
  const detailRows = details.map((detail) => {
    if (isBlankRow(detail)) {
      return '<tr class="detail-separator" aria-hidden="true"><td colspan="9"></td></tr>';
    }

    detailOrdinal += 1;
    return `<tr>
      <td class="number">${detailOrdinal}</td>
      <td class="number">${formatCell(detail.length)}</td>
      <td class="number">${formatCell(detail.width)}</td>
      <td class="number">${formatCell(detail.quantity)}</td>
      <td class="number">${formatDecimal(roundArea(detail))}</td>
      <td>${formatCell(detail.milling_type?.milling_type_name)}</td>
      <td>${formatCell(detail.edge_type?.edge_type_name)}</td>
      <td>${formatCell(detail.notes)}</td>
      <td>${formatCell(detail.film?.film_name)}</td>
    </tr>`;
  }).join('\n');

  const headerFields = [
    ['Название', order.orderName],
    ['Дата', formatDate(order.orderDate)],
    ['Заказчик', order.clientName],
    ['Телефон', order.clientPhone],
    ['№ присадки', order.prisadkaName],
    ['Конструктор', designer],
    ['Фрезеровка', commonValue(actualDetails, (detail) => detail.milling_type?.milling_type_name)],
    ['Обкат', commonValue(actualDetails, (detail) => detail.edge_type?.edge_type_name)],
    ['Плёнка', commonValue(actualDetails, (detail) => detail.film?.film_name)],
    ['Материал', commonValue(actualDetails, (detail) => detail.material?.material_name)],
    ['Общая площадь', `${formatDecimal(totalArea)} м²`],
    ['Кол-во деталей', totalQuantity],
  ].map(([label, value]) => `
    <div class="header-field">
      <span>${escapeHtml(String(label))}</span>
      <strong>${formatCell(value)}</strong>
    </div>`).join('');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="light only" />
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 8mm;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: #fff;
      color: #111;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9px;
      line-height: 1.25;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    h1 { font-size: 17px; margin: 0; }
    .document-heading {
      align-items: baseline;
      border-bottom: 2px solid #111;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 6px;
      padding-bottom: 5px;
    }
    .document-heading__name {
      font-size: 11px;
      font-weight: 700;
      text-align: right;
    }
    .header-grid {
      border-left: 1px solid #777;
      border-top: 1px solid #777;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-bottom: 8px;
    }
    .header-field {
      border-bottom: 1px solid #777;
      border-right: 1px solid #777;
      min-height: 32px;
      padding: 3px 5px;
    }
    .header-field span {
      color: #444;
      display: block;
      font-size: 7px;
      margin-bottom: 1px;
      text-transform: uppercase;
    }
    .header-field strong {
      display: block;
      font-size: 9px;
      overflow-wrap: anywhere;
    }
    table {
      border-collapse: collapse;
      table-layout: fixed;
      width: 100%;
    }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td {
      border: 1px solid #555;
      padding: 3px 4px;
      vertical-align: middle;
    }
    th {
      background: #e8e8e8;
      font-size: 8px;
      font-weight: 700;
      text-align: center;
    }
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
      border-left: 0;
      border-right: 0;
      height: 5px;
      padding: 0;
    }
    col:nth-child(1) { width: 4%; }
    col:nth-child(2), col:nth-child(3) { width: 8%; }
    col:nth-child(4) { width: 6%; }
    col:nth-child(5) { width: 9%; }
    col:nth-child(6) { width: 15%; }
    col:nth-child(7) { width: 11%; }
    col:nth-child(8) { width: 25%; }
    col:nth-child(9) { width: 14%; }
  </style>
</head>
<body>
  <header>
    <div class="document-heading">
      <h1>Заказ ${escapeHtml(orderNumber)}</h1>
      <div class="document-heading__name">${formatCell(order.orderName)}</div>
    </div>
    <div class="header-grid">${headerFields}
    </div>
  </header>
  <main>
    <table aria-label="Детали заказа для производства">
      <colgroup>${'<col />'.repeat(9)}</colgroup>
      <thead>
        <tr>
          <th scope="col">№</th>
          <th scope="col">Высота, мм</th>
          <th scope="col">Ширина, мм</th>
          <th scope="col">Кол-во</th>
          <th scope="col">Площадь, м²</th>
          <th scope="col">Тип детали</th>
          <th scope="col">Обкат</th>
          <th scope="col">Примечание</th>
          <th scope="col">Плёнка</th>
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
