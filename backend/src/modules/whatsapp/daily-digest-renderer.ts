import { Injectable } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';
import { ApiError } from '../../common/errors/api-error';
import { FONT_FAMILY, resolveFontPath } from '../cut/render/sheet-png';
import {
  DAILY_DIGEST_MAX_ORDERS,
  DAILY_DIGEST_MAX_PAGE_BYTES,
  DAILY_DIGEST_MAX_RUN_BYTES,
  type DailyDigestOrderCard,
  type DailyDigestRenderedPage,
  type DailyDigestSnapshot,
} from './daily-digest-snapshot.types';

const IMAGE_WIDTH = 480;
const PAGE_GUTTER = 16;
const CARD_WIDTH = IMAGE_WIDTH - PAGE_GUTTER * 2;
const HEADER_HEIGHT = 96;
const CARD_GAP = 12;
const PAGE_FOOTER_HEIGHT = 24;
const MAX_RENDER_DURATION_MS = 30_000;

interface CardLayout {
  svg: string;
  height: number;
}

@Injectable()
export class DailyDigestRenderer {
  async render(snapshot: DailyDigestSnapshot): Promise<DailyDigestRenderedPage[]> {
    validateSnapshot(snapshot);
    if (snapshot.orders.length === 0) return [];

    const sortedOrders = [...snapshot.orders].sort((left, right) => left.orderId - right.orderId);
    const totalPages = Math.ceil(sortedOrders.length / snapshot.cardsPerMessage);
    const pages: DailyDigestRenderedPage[] = [];
    let totalBytes = 0;
    const startedAt = Date.now();

    for (let pageOffset = 0; pageOffset < sortedOrders.length; pageOffset += snapshot.cardsPerMessage) {
      // Resvg is synchronous; yield between bounded pages so a maximum-size
      // digest does not monopolize the Nest event loop for the whole run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pageIndex = pages.length + 1;
      const orders = sortedOrders.slice(pageOffset, pageOffset + snapshot.cardsPerMessage);
      const header = pageIndex === 1 ? renderDayHeader(snapshot) : '';
      let y = pageIndex === 1 ? HEADER_HEIGHT + 18 : PAGE_GUTTER;
      const cardSvgs: string[] = [];
      for (const order of orders) {
        const card = renderOrderCard(order, snapshot);
        cardSvgs.push(`<g transform="translate(${PAGE_GUTTER} ${y})">${card.svg}</g>`);
        y += card.height + CARD_GAP;
      }
      y = Math.max(PAGE_GUTTER + 120, y - CARD_GAP + PAGE_FOOTER_HEIGHT);
      const svg = pageSvg({
        height: y,
        header,
        cardSvgs,
        pageIndex,
        totalPages,
      });
      const png = rasterize(svg);
      if (png.byteLength > DAILY_DIGEST_MAX_PAGE_BYTES) {
        throw new ApiError(
          422,
          'DAILY_DIGEST_PAGE_TOO_LARGE',
          `Изображение страницы ${pageIndex} превышает лимит 1 МиБ. Полное сообщение не подготовлено и не будет отправлено.`,
          { pageIndex, byteLimit: DAILY_DIGEST_MAX_PAGE_BYTES },
        );
      }
      totalBytes += png.byteLength;
      if (totalBytes > DAILY_DIGEST_MAX_RUN_BYTES) {
        throw new ApiError(
          422,
          'DAILY_DIGEST_RUN_TOO_LARGE',
          'Изображения сводки превышают общий лимит 16 МиБ. Полное сообщение не подготовлено и не будет отправлено.',
          { byteLimit: DAILY_DIGEST_MAX_RUN_BYTES },
        );
      }
      pages.push({ pageIndex, orderIds: orders.map((order) => order.orderId), png });
      if (Date.now() - startedAt > MAX_RENDER_DURATION_MS) {
        throw new ApiError(
          422,
          'DAILY_DIGEST_RENDER_TIMEOUT',
          'Подготовка изображений превысила лимит 30 секунд. Сводка не подготовлена и не будет отправлена.',
          { pageCount: pages.length },
        );
      }
    }

    return pages;
  }
}

function validateSnapshot(snapshot: DailyDigestSnapshot): void {
  if (!snapshot || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.businessDate)) {
    throw new ApiError(422, 'DAILY_DIGEST_SNAPSHOT_INVALID', 'В снимке сводки указана некорректная дата.');
  }
  if (snapshot.cardsPerMessage !== 1 && snapshot.cardsPerMessage !== 2) {
    throw new ApiError(422, 'DAILY_DIGEST_SNAPSHOT_INVALID', 'В одном сообщении допускается от одной до двух карточек.');
  }
  if (!Array.isArray(snapshot.orders) || snapshot.orders.length > DAILY_DIGEST_MAX_ORDERS) {
    throw new ApiError(
      422,
      'DAILY_DIGEST_ORDER_LIMIT_EXCEEDED',
      `В снимке сводки больше ${DAILY_DIGEST_MAX_ORDERS} заказов. Полное сообщение не подготовлено и не будет отправлено.`,
      { orderLimit: DAILY_DIGEST_MAX_ORDERS },
    );
  }
  if (!Number.isFinite(snapshot.totalArea) || snapshot.totalArea < 0) {
    throw new ApiError(422, 'DAILY_DIGEST_SNAPSHOT_INVALID', 'Общая площадь в снимке сводки должна быть неотрицательным числом.');
  }
  if (!snapshot.workflowDisplay || !Array.isArray(snapshot.workflowDisplay.displayOrderCodes)) {
    throw new ApiError(422, 'DAILY_DIGEST_SNAPSHOT_INVALID', 'В снимке сводки отсутствуют параметры отображения этапов.');
  }
  for (const order of snapshot.orders) {
    if (!Number.isInteger(order.orderId) || order.orderId < 1 || !Number.isFinite(order.totalArea)) {
      throw new ApiError(422, 'DAILY_DIGEST_SNAPSHOT_INVALID', 'Снимок сводки содержит некорректную карточку заказа.');
    }
  }
}

function renderDayHeader(snapshot: DailyDigestSnapshot): string {
  const [year, month, day] = snapshot.businessDate.split('-').map(Number);
  const weekday = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const dateLabel = `${pad2(day)}.${pad2(month)}.${year}`;
  const areaLabel = `${formatArea(snapshot.totalArea)} м²`;
  return [
    rect(PAGE_GUTTER, 12, CARD_WIDTH, 72, '#ffffff', '#d9e1e8', 2, 10),
    text(PAGE_GUTTER + 14, 42, `${weekday}, ${dateLabel}`, 21, '#202b35', 700),
    text(PAGE_GUTTER + 14, 68, `${snapshot.orders.length} заказов`, 14, '#687887', 400),
    text(IMAGE_WIDTH - PAGE_GUTTER - 14, 56, areaLabel, 22, '#1f2933', 700, 'end'),
  ].join('');
}

function renderOrderCard(order: DailyDigestOrderCard, snapshot: DailyDigestSnapshot): CardLayout {
  const x = 0;
  const innerX = 14;
  const textWidth = CARD_WIDTH - 2 * innerX;
  const titleLines = wrapText(order.orderName, 35, 2, 'order title');
  const basisLines = order.basisProjectDisplay
    ? wrapText(order.basisProjectDisplay, 35, 2, 'BASIS name')
    : [];
  const materialRows = wrapMaterials(order.materials, textWidth);
  const milling = order.millingDisplay || '—';
  const millingLines = wrapText(`. ${milling} – ${formatArea(order.totalArea)} кв.м.`, 50, 2, 'milling line');
  const dateLabel = order.orderDate ? formatDateKey(order.orderDate) : '';
  const infoText = [dateLabel, order.clientName?.trim()].filter(Boolean).join(' • ');
  const infoLines = infoText ? wrapText(infoText, 50, 3, 'order date and client') : [];
  const paymentLines = order.paymentStatusName.trim()
    ? wrapText(order.paymentStatusName.trim(), 50, 2, 'payment status')
    : [];
  const stages = getPassedStages(order.passedProductionCodes, snapshot);

  let y = 20;
  const elements: string[] = [];
  const status = order.orderStatusName.trim().toLocaleLowerCase('ru-RU');
  const background = statusColor(status);
  const border = status === 'выдан' ? '#8B4513' : status === 'готов к выдаче' ? '#52c41a' : '#ffe4cc';
  elements.push(rect(x, 0, CARD_WIDTH, 1, background, border, 2, 10));
  elements.push(rect(x, 0, 6, 1, border, border, 0, 3));

  const titleColor = order.orderName.startsWith('К') ? '#8B4513' : '#1976d2';
  if (status === 'выдан') {
    elements.push(rect(innerX, y - 13, 16, 16, '#ffffff', '#8B4513', 1.5, 3));
    elements.push(`<path d="M ${innerX + 3} ${y - 5} l 4 4 l 7 -9" fill="none" stroke="#8B4513" stroke-width="2"/>`);
  } else {
    elements.push(rect(innerX, y - 13, 16, 16, '#ffffff', '#b7c0c7', 1.5, 3));
  }
  const titleHeight = renderLines(elements, titleLines, innerX + 24, y, 20, titleColor, 700, 25);
  y += titleHeight + 8;
  if (basisLines.length) {
    y += renderLines(elements, basisLines, innerX + 24, y, 16, '#DC2626', 700, 21) + 4;
  }

  if (materialRows.length) {
    for (const row of materialRows) {
      let tagX = innerX;
      for (const material of row) {
        const { label } = material;
        const width = measuredTagWidth(label);
        const color = materialColor(material.fullName);
        elements.push(rect(tagX, y - 16, width, 25, color, '#d3d9de', 1, 4));
        elements.push(text(tagX + 7, y + 1, label, 12, '#1f1f1f', 600));
        tagX += width + 8;
      }
      y += 32;
    }
    y += 2;
  }

  y += renderLines(elements, millingLines, innerX, y, 15, '#595959', 400, 20) + 3;
  if (infoLines.length) {
    y += renderLines(elements, infoLines, innerX, y, 14, '#687887', 400, 19) + 2;
  }
  if (paymentLines.length) {
    const unpaid = order.paymentStatusName.toLocaleLowerCase('ru-RU').includes('не оплачен');
    y += renderLines(elements, paymentLines, innerX, y, 14, unpaid ? '#d32f2f' : '#666666', 400, 19) + 4;
  }

  const dividerY = y + 1;
  elements.push(`<line x1="${innerX}" y1="${dividerY}" x2="${CARD_WIDTH - innerX}" y2="${dividerY}" stroke="#dfe3e7" stroke-width="1"/>`);
  y = dividerY + 25;
  if (stages.length) {
    const label = stages.map((stage) => stage.letter).join('/');
    const stageLines = wrapText(label, 50, 2, 'production stages');
    renderLines(elements, stageLines, innerX, y, 13, '#fa8c16', 700, 17);
    y += stageLines.length * 17;
  } else {
    y += 7;
  }

  const height = Math.max(150, y + 18);
  // Replace sentinel height with the calculated height after children are laid out.
  elements[0] = rect(x, 0, CARD_WIDTH, height, background, border, 2, 10);
  elements[1] = rect(x, 0, 6, height, border, border, 0, 3);
  return { svg: elements.join(''), height };
}

function renderLines(
  elements: string[],
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  fill: string,
  weight: number,
  lineHeight: number,
): number {
  lines.forEach((line, index) => elements.push(text(x, y + index * lineHeight, line, fontSize, fill, weight)));
  return lines.length * lineHeight;
}

function wrapMaterials(
  materials: DailyDigestOrderCard['materials'],
  availableWidth: number,
): DailyDigestOrderCard['materials'][] {
  const rows: DailyDigestOrderCard['materials'][] = [];
  let row: DailyDigestOrderCard['materials'] = [];
  let width = 0;
  for (const material of materials) {
    const tagWidth = measuredTagWidth(material.label);
    if (tagWidth > availableWidth) {
      throw oversizedTextError('material label');
    }
    if (row.length > 0 && width + tagWidth + 8 > availableWidth) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(material);
    width += tagWidth + 8;
  }
  if (row.length) rows.push(row);
  if (rows.length > 2) throw oversizedTextError('material list');
  return rows;
}

function measuredTagWidth(label: string): number {
  return Math.max(30, Array.from(label).length * 7.5 + 14);
}

function wrapText(value: string, maxChars: number, maxLines: number, field: string): string[] {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const chunks = Array.from(word).length > maxChars
      ? splitCodePoints(word, maxChars)
      : [word];
    for (const chunk of chunks) {
      const candidate = line ? `${line} ${chunk}` : chunk;
      if (Array.from(candidate).length <= maxChars) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = chunk;
      }
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) throw oversizedTextError(field);
  return lines;
}

function splitCodePoints(value: string, maxChars: number): string[] {
  const points = Array.from(value);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += maxChars) {
    chunks.push(points.slice(index, index + maxChars).join(''));
  }
  return chunks;
}

function getPassedStages(
  passedCodes: string[],
  snapshot: DailyDigestSnapshot,
): Array<{ code: string; letter: string }> {
  const passed = new Set(passedCodes);
  const order = snapshot.workflowDisplay.displayOrderCodes;
  const codes = [
    ...order.filter((code) => passed.has(code)),
    ...passedCodes.filter((code) => !order.includes(code)),
  ];
  return codes.map((code) => ({
    code,
    letter: (snapshot.workflowDisplay.codeToLetter[code] || '?').trim().slice(0, 1).toLocaleUpperCase('ru-RU'),
  }));
}

function pageSvg(input: {
  height: number;
  header: string;
  cardSvgs: string[];
  pageIndex: number;
  totalPages: number;
}): string {
  const counter = text(IMAGE_WIDTH - PAGE_GUTTER, input.height - 8, `${input.pageIndex}/${input.totalPages}`, 12, '#89939c', 400, 'end');
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${input.height}" viewBox="0 0 ${IMAGE_WIDTH} ${input.height}">` +
    `<rect width="100%" height="100%" fill="#f4f6f8"/>` +
    input.header + input.cardSvgs.join('') + counter +
    '</svg>';
}

function rasterize(svg: string): Buffer {
  const fontPath = resolveFontPath();
  if (!fontPath) throw new ApiError(503, 'DAILY_DIGEST_FONT_UNAVAILABLE', 'Не найден встроенный шрифт для изображения карточки заказа.');
  try {
    const image = new Resvg(svg, {
      font: { fontFiles: [fontPath], defaultFontFamily: FONT_FAMILY, loadSystemFonts: false },
    });
    return Buffer.from(image.render().asPng());
  } catch {
    throw new ApiError(422, 'DAILY_DIGEST_RENDER_FAILED', 'Не удалось подготовить изображение карточки заказа. Сводка не будет отправлена.');
  }
}

function statusColor(status: string): string {
  if (status === 'готов') return '#ffd9bf';
  if (status === 'в работе' || status.includes('работ')) return '#fff9e6';
  if (status === 'отменен' || status.includes('отмен')) return '#ffe6e6';
  return '#ffffff';
}

function materialColor(material: string): string {
  const value = material.toLocaleLowerCase('ru-RU').trim();
  if (value.includes('18')) return '#fff3cd';
  if (value.includes('16')) return '#ffeaa7';
  if (value.includes('10')) return '#90caf9';
  if (value.includes('8')) return '#c8e6c9';
  if (value.includes('лдсп')) return '#ce93d8';
  if (value.includes('мдф')) return '#ffcc80';
  if (value.includes('фанера')) return '#d7ccc8';
  return '#f0f0f0';
}

function formatArea(area: number): string {
  return area.toFixed(2);
}

function formatDateKey(value: string): string {
  const date = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function text(
  x: number,
  y: number,
  value: string,
  fontSize: number,
  fill: string,
  weight: number,
  anchor: 'start' | 'end' = 'start',
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
  radius: number,
): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function oversizedTextError(field: string): ApiError {
  return new ApiError(
    422,
    'DAILY_DIGEST_CONTENT_TOO_LARGE',
    `Поле «${field}» слишком велико для изображения карточки. Сводка не подготовлена и не будет отправлена.`,
    { field },
  );
}
