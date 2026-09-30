import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// Compact, narrow layout (CSS px) modelled on the calendar order card; the PNG
// is rasterized at RENDER_ZOOM so text stays crisp when WhatsApp scales it.
export const DAILY_DIGEST_LAYOUT_WIDTH = 260;
export const DAILY_DIGEST_RENDER_ZOOM = 2.5;
const IMAGE_WIDTH = DAILY_DIGEST_LAYOUT_WIDTH;
const PAGE_GUTTER = 10;
const CARD_WIDTH = IMAGE_WIDTH - PAGE_GUTTER * 2;
const CARD_PAD_X = 10;
const CARD_PAD_TOP = 8;
const CARD_PAD_BOTTOM = 8;
const TEXT_WIDTH = CARD_WIDTH - 2 * CARD_PAD_X;
const HEADER_HEIGHT = 34;
const CARD_GAP = 8;
const PAGE_FOOTER_HEIGHT = 16;
/**
 * All pages of one digest share one height: the tallest page (normally the first one, with the day
 * header), and never less than MIN_PAGE_ASPECT x width. WhatsApp shows an image taller than wide
 * narrow and a square or wide one at full width, so equal "tall" proportions keep every image
 * exactly as narrow as the first one. Shorter pages keep empty space below their cards.
 */
const MIN_PAGE_ASPECT = 1.1;
const MAX_RENDER_DURATION_MS = 30_000;
const BOLD_FONT_FILE = 'LiberationSans-Bold.ttf';

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

    // Lay out every page first: the common page height is only known after the tallest one.
    const layouts: Array<{ pageIndex: number; orders: DailyDigestOrderCard[]; header: string; cardSvgs: string[]; height: number }> = [];
    for (let pageOffset = 0; pageOffset < sortedOrders.length; pageOffset += snapshot.cardsPerMessage) {
      const pageIndex = layouts.length + 1;
      const orders = sortedOrders.slice(pageOffset, pageOffset + snapshot.cardsPerMessage);
      const header = pageIndex === 1 ? renderDayHeader(snapshot) : '';
      let y = pageIndex === 1 ? HEADER_HEIGHT + 6 : PAGE_GUTTER;
      const cardSvgs: string[] = [];
      for (const order of orders) {
        const card = renderOrderCard(order, snapshot);
        cardSvgs.push(`<g transform="translate(${PAGE_GUTTER} ${y})">${card.svg}</g>`);
        y += card.height + CARD_GAP;
      }
      layouts.push({ pageIndex, orders, header, cardSvgs, height: y - CARD_GAP + PAGE_FOOTER_HEIGHT });
    }
    const pageHeight = Math.max(Math.ceil(IMAGE_WIDTH * MIN_PAGE_ASPECT), ...layouts.map((layout) => layout.height));

    for (const { pageIndex, orders, header, cardSvgs } of layouts) {
      // Resvg is synchronous; yield between bounded pages so a maximum-size
      // digest does not monopolize the Nest event loop for the whole run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const svg = pageSvg({
        height: pageHeight,
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
    text(PAGE_GUTTER + 2, 22, `${weekday} (${dateLabel})`, 14, '#1f1f1f', 700),
    text(IMAGE_WIDTH - PAGE_GUTTER - 2, 22, areaLabel, 14, '#d4380d', 700, 'end'),
    `<line x1="${PAGE_GUTTER}" y1="${HEADER_HEIGHT - 5}" x2="${IMAGE_WIDTH - PAGE_GUTTER}" y2="${HEADER_HEIGHT - 5}" stroke="#d9e1e8" stroke-width="1"/>`,
  ].join('');
}

function baselineOf(top: number, lineHeight: number, fontSize: number): number {
  return top + (lineHeight - fontSize) / 2 + fontSize * 0.82;
}

function renderOrderCard(order: DailyDigestOrderCard, snapshot: DailyDigestSnapshot): CardLayout {
  const innerX = CARD_PAD_X;
  const titleX = innerX + 20;
  const titleWidth = TEXT_WIDTH - 20;
  const titleLines = wrapText(order.orderName, titleWidth, 2, 'order title', 18, true);
  const basisText = order.basisProjectDisplay ? `- ${order.basisProjectDisplay.trim()}` : '';
  const materialWidths = order.materials.map((material) => measuredTagWidth(material.label));
  const tagsTotal = materialWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, materialWidths.length - 1) * TAG_GAP;
  const milling = order.millingDisplay || '—';
  const millingLines = wrapText(`. ${milling} – ${formatArea(order.totalArea)} кв.м.`, TEXT_WIDTH, 2, 'milling line', 13, false);
  const dateLabel = order.orderDate ? formatDateKey(order.orderDate) : '';
  const infoText = [dateLabel, order.clientName?.trim()].filter(Boolean).join(' • ');
  const infoLines = infoText ? wrapText(infoText, TEXT_WIDTH, 3, 'order date and client', 12, false) : [];
  const paymentLines = order.paymentStatusName.trim()
    ? wrapText(order.paymentStatusName.trim(), TEXT_WIDTH, 2, 'payment status', 12, true)
    : [];
  const stages = getPassedStages(order.passedProductionCodes, snapshot);

  const elements: string[] = [];
  const status = order.orderStatusName.trim().toLocaleLowerCase('ru-RU');
  const background = statusColor(status);
  const accent = status === 'выдан' ? '#8B4513' : status === 'готов к выдаче' ? '#52c41a' : '#ffe4cc';
  const titleColor = order.orderName.startsWith('К') ? '#8B4513' : '#1976d2';

  let y = CARD_PAD_TOP;
  const titleLineHeight = 22;
  const firstBaseline = baselineOf(y, titleLineHeight, 18);
  if (status === 'выдан') {
    elements.push(rect(innerX, firstBaseline - 13, 14, 14, '#ffffff', '#8B4513', 1.5, 3));
    elements.push(`<path d="M ${innerX + 3} ${firstBaseline - 6} l 3.5 3.5 l 5.5 -8" fill="none" stroke="#8B4513" stroke-width="2"/>`);
  } else {
    elements.push(rect(innerX, firstBaseline - 13, 14, 14, '#ffffff', '#8b969f', 1.5, 3));
  }
  titleLines.forEach((line, index) => {
    elements.push(text(titleX, firstBaseline + index * titleLineHeight, line, 18, titleColor, 700));
  });
  const lastTitleWidth = measureText(titleLines[titleLines.length - 1] ?? '', 18, true);
  let basisLines: string[] = [];
  let basisInline = false;
  if (basisText) {
    const inlineWidth = measureText(` ${basisText}`, 13, true);
    if (titleLines.length === 1 && lastTitleWidth + inlineWidth <= titleWidth) {
      basisInline = true;
      elements.push(text(titleX + lastTitleWidth, firstBaseline, ` ${basisText}`, 13, '#DC2626', 700));
    } else {
      basisLines = wrapText(basisText, titleWidth, 2, 'BASIS name', 13, true);
    }
  }
  const firstRowUsed = titleX + (titleLines.length === 1 ? lastTitleWidth : titleWidth) +
    (basisInline ? measureText(` ${basisText}`, 13, true) : 0) - innerX;
  y += titleLines.length * titleLineHeight;
  for (const line of basisLines) {
    elements.push(text(titleX, baselineOf(y, 16, 13), line, 13, '#DC2626', 700));
    y += 16;
  }

  if (order.materials.length) {
    const fitsInRow = titleLines.length === 1 && basisLines.length === 0 &&
      firstRowUsed + 8 + tagsTotal <= TEXT_WIDTH;
    if (fitsInRow) {
      let tagX = CARD_WIDTH - CARD_PAD_X - tagsTotal;
      const tagTop = firstBaseline - 13;
      order.materials.forEach((material, index) => {
        elements.push(...renderTag(tagX, tagTop, materialWidths[index], material));
        tagX += materialWidths[index] + TAG_GAP;
      });
    } else {
      const rows = wrapMaterials(order.materials, TEXT_WIDTH);
      for (const row of rows) {
        let tagX = innerX;
        for (const material of row) {
          const width = measuredTagWidth(material.label);
          elements.push(...renderTag(tagX, y + 1, width, material));
          tagX += width + TAG_GAP;
        }
        y += 20;
      }
    }
  }

  y += 1;
  millingLines.forEach((line, index) => {
    elements.push(text(innerX, baselineOf(y + index * 17, 17, 13), line, 13, '#262626', 400));
  });
  y += millingLines.length * 17;
  infoLines.forEach((line, index) => {
    elements.push(text(innerX, baselineOf(y + index * 15, 15, 12), line, 12, '#3d4852', 400));
  });
  y += infoLines.length * 15;
  if (paymentLines.length) {
    const unpaid = order.paymentStatusName.toLocaleLowerCase('ru-RU').includes('не оплачен');
    paymentLines.forEach((line, index) => {
      elements.push(text(innerX, baselineOf(y + index * 15, 15, 12), line, 12, unpaid ? '#d32f2f' : '#2f3a45', 700));
    });
    y += paymentLines.length * 15;
  }

  if (stages.length) {
    y += 5;
    elements.push(`<line x1="${innerX}" y1="${y}" x2="${CARD_WIDTH - innerX}" y2="${y}" stroke="#e3d5c6" stroke-width="1"/>`);
    y += 3;
    const stageLines = wrapText(stages.map((stage) => stage.letter).join('/'), TEXT_WIDTH, 2, 'production stages', 13, true);
    stageLines.forEach((line, index) => {
      elements.push(text(CARD_WIDTH / 2, baselineOf(y + index * 17, 17, 13), line, 13, '#f07800', 700, 'middle'));
    });
    y += stageLines.length * 17;
  }

  const height = y + CARD_PAD_BOTTOM;
  const clipId = `card-${order.orderId}`;
  const frame = [
    `<clipPath id="${clipId}"><rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" rx="6"/></clipPath>`,
    `<g clip-path="url(#${clipId})">`,
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" fill="${background}"/>`,
    `<rect x="0" y="0" width="3" height="${height}" fill="${accent}"/>`,
    '</g>',
    `<rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${height - 1}" rx="6" fill="none" stroke="#ecd5bc" stroke-width="1"/>`,
  ].join('');
  return { svg: frame + elements.join(''), height };
}

const TAG_GAP = 4;

function renderTag(x: number, top: number, width: number, material: DailyDigestOrderCard['materials'][number]): string[] {
  return [
    rect(x, top, width, 16, materialColor(material.fullName), '#c9b99f', 0.75, 3),
    text(x + width / 2, top + 12, material.label, 11, '#1f1f1f', 700, 'middle'),
  ];
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
    if (row.length > 0 && width + tagWidth + TAG_GAP > availableWidth) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(material);
    width += tagWidth + TAG_GAP;
  }
  if (row.length) rows.push(row);
  if (rows.length > 2) throw oversizedTextError('material list');
  return rows;
}

function measuredTagWidth(label: string): number {
  return Math.max(24, measureText(label, 11, true) + 10);
}

/** Conservative Liberation Sans advance estimate (upper case and bold run wider). */
function measureText(value: string, fontSize: number, bold: boolean): number {
  let em = 0;
  for (const char of value) {
    if (char === ' ') em += 0.28;
    else if (/[0-9]/u.test(char)) em += 0.556;
    else if (/[.,:;•\-–—'"«»()]/u.test(char)) em += 0.36;
    else if (/[A-ZА-ЯЁ]/u.test(char)) em += 0.72;
    else em += 0.57;
  }
  return em * fontSize * (bold ? 1.06 : 1);
}

function wrapText(
  value: string,
  maxWidth: number,
  maxLines: number,
  field: string,
  fontSize: number,
  bold: boolean,
): string[] {
  const fits = (candidate: string): boolean => measureText(candidate, fontSize, bold) <= maxWidth;
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const chunks = fits(word) ? [word] : splitToWidth(word, fits);
    for (const chunk of chunks) {
      const candidate = line ? `${line} ${chunk}` : chunk;
      if (fits(candidate)) {
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

function splitToWidth(value: string, fits: (candidate: string) => boolean): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (chunk && !fits(chunk + char)) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
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
  const counter = text(IMAGE_WIDTH - PAGE_GUTTER, input.height - 4, `${input.pageIndex}/${input.totalPages}`, 9, '#9aa4ad', 400, 'end');
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${input.height}" viewBox="0 0 ${IMAGE_WIDTH} ${input.height}">` +
    `<rect width="100%" height="100%" fill="#f4f6f8"/>` +
    input.header + input.cardSvgs.join('') + counter +
    '</svg>';
}

function statusColor(status: string): string {
  if (status === 'готов') return '#ffd9bf';
  if (status === 'в работе' || status.includes('работ')) return '#ffffff';
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

let cachedBoldFontPath: string | null = null;

/** Bundled Bold face; resvg synthesizes nothing, so weight 700 needs its own TTF. */
export function resolveBoldFontPath(): string | null {
  if (cachedBoldFontPath) return cachedBoldFontPath;
  const found = [
    resolve(__dirname, '../../../assets/fonts', BOLD_FONT_FILE),
    join(process.cwd(), 'assets/fonts', BOLD_FONT_FILE),
    join(process.cwd(), 'backend/assets/fonts', BOLD_FONT_FILE),
  ].find((candidate) => existsSync(candidate)) ?? null;
  cachedBoldFontPath = found;
  return found;
}

function rasterize(svg: string): Buffer {
  const regularPath = resolveFontPath();
  const boldPath = resolveBoldFontPath();
  if (!regularPath || !boldPath) {
    throw new ApiError(503, 'DAILY_DIGEST_FONT_UNAVAILABLE', 'Не найден встроенный шрифт для изображения карточки заказа.');
  }
  try {
    const image = new Resvg(svg, {
      fitTo: { mode: 'zoom', value: DAILY_DIGEST_RENDER_ZOOM },
      font: { fontFiles: [regularPath, boldPath], defaultFontFamily: FONT_FAMILY, loadSystemFonts: false },
    });
    return Buffer.from(image.render().asPng());
  } catch {
    throw new ApiError(422, 'DAILY_DIGEST_RENDER_FAILED', 'Не удалось подготовить изображение карточки заказа. Сводка не будет отправлена.');
  }
}

function text(
  x: number,
  y: number,
  value: string,
  fontSize: number,
  fill: string,
  weight: number,
  anchor: 'start' | 'middle' | 'end' = 'start',
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
