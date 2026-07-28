import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(
  'src/pages/orderStatusBoard/OrderStatusBoardPage.tsx',
  'utf8',
);
const css = readFileSync(
  'src/pages/orderStatusBoard/orderStatusBoard.css',
  'utf8',
);
const interaction = readFileSync(
  'src/pages/orderStatusBoard/interaction.ts',
  'utf8',
);

describe('OrderStatusBoardPage UX guards', () => {
  it('keeps keyboard move, live announcements and focus restoration', () => {
    expect(page).toContain('aria-label={`Переместить заказ');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('aria-describedby');
    expect(page).toContain('restoreOrderStatusBoardFocus');
    expect(page).toContain('data-status-board-order-id');
  });

  it('keeps production auto-mode side effects behind explicit confirmation', () => {
    expect(interaction).toContain('productionStatusFromDetailsEnabled');
    expect(page).toContain('Перевести заказ в ручной режим?');
    expect(page).toContain('отключит авторасчёт');
    expect(interaction).toContain('if (!confirmed)');
  });

  it('keeps mobile drag-free and respects reduced motion', () => {
    expect(page).toContain("window.matchMedia('(pointer: fine)')");
    expect(page).toContain('canDrag: moveAvailable && finePointer');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('scroll-snap-type: x mandatory');
  });

  it('keeps the upper scrollbar synchronized with the board viewport', () => {
    expect(page).toContain('topScrollbarTrack.style.width');
    expect(page).toContain('scrollBoardFromTop');
    expect(page).toContain('scrollTopFromBoard');
    expect(page).toContain('aria-controls="status-board-viewport"');
    expect(css).toContain('.status-board-scrollbar');
    expect(css).toContain('overflow-x: auto');
  });

  it('summarizes payment without exposing money amounts in status-board cards', () => {
    expect(page).toContain('formatPaymentSummary(card)');
    expect(page).toContain("return 'оплачен'");
    expect(page).toContain("return 'частично оплачен'");
    expect(page).toContain("return 'не оплачен'");
    expect(page).not.toContain('formatMoney(');
    expect(page).not.toContain('CURRENCY_CODE');
    expect(page).not.toContain('paymentStatusName ||');
  });

  it('shows the completed-status opt-in only on the production tab with a usable hit area', () => {
    expect(page).toContain("viewState.view === 'production'");
    expect(page).toContain('Показывать завершённые');
    expect(page).toContain('showDone: event.target.checked');
    expect(css).toContain('.status-board-toolbar__checkbox');
    expect(css).toContain('min-height: 40px');
  });

  it('keeps CNC work as a separate visual flow and API contract', () => {
    expect(page).toContain('cncTelegram: featureFlags.cncTelegram');
    expect(page).toContain("key: 'cnc_today'");
    expect(page).toContain('cncTelegramApi.today');
    expect(page).toContain('workday ? { date: workday } : {}');
    expect(page).toContain('<CncTelegramTodayColumns');
    expect(page).toContain("label: 'МДФ-работы'");
    expect(page).toContain("parsed: 'Файлы на станке'");
    expect(page).toContain('CncTelegramBathCardView');
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).toContain('CNC_HISTORY_DAYS = 7');
    expect(page).toContain('aria-label="Дата CNC-работ"');
    expect(page).toContain('В чате {formatDateTime');
    expect(page).toContain('<Collapse.Panel');
    expect(page).toContain('cncColumnDisplayTitle(column)');
    expect(page).toContain("baths: 'Ванны'");
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).not.toContain('Строка не сопоставлена с ERP');
    expect(page).not.toContain('items={[{');
    expect(page).not.toContain("board: 'cnc");
  });

  it('keeps bath cards printable with SVG and PDF previews', () => {
    expect(page).toContain('cutApi.fetchSheetSvg');
    expect(page).toContain('cutApi.fetchJobPdf');
    expect(page).toContain("CNC_BATH_DEFAULT_PDF_TEMPLATE = 'bath_profiles'");
    expect(page).toContain('Шаблон PDF ванны');
    expect(page).toContain("import('pdfjs-dist')");
    expect(page).toContain('renderCncPdfPagePreviews(result.blob)');
    expect(page).toContain('data-testid="cnc-bath-pdf-preview-pages"');
    expect(page).not.toContain('<iframe');
    expect(page).toContain('PrinterOutlined');
    expect(page).toContain('DownloadOutlined');
    expect(css).toContain('.cnc-bath-card__pdf-pages');
    expect(css).toContain('.cnc-bath-card__pdf-page-image');
    expect(css).toContain('.cnc-bath-card__ready-icon--pending');
  });

  it('keeps the completed CNC card check marker understandable', () => {
    expect(page).toContain("packet.completionStatus === 'completed'");
    expect(page).toContain('<CheckCircleOutlined />');
    expect(page).toContain('Выполнено на станке');
    expect(css).toContain('.cnc-packet-card__status-icon--completed');
    expect(css).toContain('border-radius: 50%');
  });

  it('shows CNC order totals directly on each card', () => {
    expect(page).toContain('buildCncOrderSummaries(packet.items)');
    expect(page).toContain('aria-label="Итоги по заказам"');
    expect(page).toContain('<CncOrderSummaryLine');
    expect(page).toContain('aria-label={`Открыть заказ ${summary.orderName}`}');
    expect(page).toContain('onOpenOrder(orderId)');
    expect(page).toContain('summary.orderName');
    expect(page).toContain('summary.orderId');
    expect(page).toContain('summary.positions');
    expect(page).toContain('summary.details');
    expect(page).toContain('summary.orderId ??= item.orderId ?? item.matchOrderId ?? null');
    expect(page).toContain('const orderId = item.orderId ?? item.matchOrderId');
    expect(css).toContain('.cnc-packet-card__summaries');
    expect(css).toContain('.cnc-packet-card__summary');
    expect(css).toContain('.cnc-packet-card__summary-order');
    expect(css).toContain('.cnc-packet-card__summary-order.ant-btn');
    expect(css).toContain('color: #1677ff');
    expect(css).toContain('.cnc-packet-card__summary-meta');
    expect(css).toContain('font-weight: 400');
    expect(css).toContain('.cnc-packet-card__program');
    expect(css).toMatch(/\.cnc-packet-card__program\s*\{[^}]*color: var\(--app-text-muted\);/);
    const cncFileNameRules = css.match(/\.cnc-packet-card__note-file\s*\{[^}]*\}/g) ?? [];
    expect(cncFileNameRules.length).toBeGreaterThan(0);
    expect(cncFileNameRules.every((rule) => rule.includes('color: var(--app-text-muted);'))).toBe(true);
  });

  it('keeps CNC relation highlighting behind the Links switch', () => {
    expect(page).toContain('const [cncRelationsEnabled, setCncRelationsEnabled] = useState(false)');
    expect(page).toContain('const [activeCncRelation, setActiveCncRelation]');
    expect(page).toContain('Связи');
    expect(page).toContain('checked={cncRelationsEnabled}');
    expect(page).toContain('if (!cncRelationsEnabled) setActiveCncRelation(null)');
    expect(page).toContain('cncRelationsEnabled');
    expect(page).toContain('? buildCncRelationContext(cncColumns, activeCncRelation)');
    expect(page).toContain('const bathCards = relationContext');
    expect(page).toContain('const packetCards = relationContext');
    expect(page).toContain('sortCncRelationCards');
    expect(page).toContain('getCncPacketRelationState');
    expect(page).toContain('getCncBathRelationState');
    expect(page).toContain('event.stopPropagation()');
    expect(css).toContain('.cnc-relation-card--dimmed');
    expect(css).toContain('filter: grayscale(0.9)');
    expect(css).toContain('opacity: 0.62');
    expect(css).not.toContain('transition: all');
  });

  it('keeps order cards dense, badge-based and project-code-free', () => {
    expect(page).toContain("type StatusBoardCardDisplayMode = 'standard' | 'compact' | 'minimal'");
    expect(page).toContain('STATUS_BOARD_CARD_DISPLAY_OPTIONS');
    expect(page).toContain('Вид карточек заказов');
    expect(page).toContain('Стандартный');
    expect(page).toContain('Компактный');
    expect(page).toContain('Минимальный');
    expect(page).toContain('formatStatusBoardOrderNumber(card)');
    expect(page).toContain('card.orderName.trim() || String(card.orderId)');
    expect(page).not.toContain('card.fullNumber');
    expect(page).not.toContain('primaryStatusLabel');
    expect(page).not.toContain('status-board-card__status-label');
    expect(page).toContain('resolveStatusBoardStatusColor(board, card, allColumns)');
    expect(page).toContain('color={primaryStatusColor}');
    expect(page).toContain('status-board-card__status-row');
    expect(page).toContain('status-board-card__status-badge');
    expect(page).toContain('status-board-card__standard-grid');
    expect(css).toContain('.status-board-toolbar__display-mode');
    expect(css).toContain('width: min(160px, 100%)');
    expect(css).toContain('.status-board-toolbar__date-range');
    expect(css).toContain('width: 224px');
    expect(css).toContain('flex-wrap: nowrap');
    expect(css).toContain('.status-board-card--compact');
    expect(css).toContain('.status-board-card--minimal');
    expect(css).toContain('.status-board-card__status-row');
    expect(css).toContain('.status-board-card__status-badge.ant-tag');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(css).toContain('.status-board-card__number.ant-btn');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  it('keeps compact order cards as plain text except for the status badge', () => {
    const compactStart = page.indexOf('{showCompactDetails && !showStandardDetails && (');
    const compactEnd = page.indexOf('{pending &&', compactStart);
    expect(compactStart).toBeGreaterThanOrEqual(0);
    expect(compactEnd).toBeGreaterThan(compactStart);
    const compactSection = page.slice(compactStart, compactEnd);

    expect(compactSection).toContain('status-board-card__compact-text');
    expect(compactSection).toContain('compactDetailText');
    expect(compactSection).not.toContain('Typography.Text');
    expect(compactSection).not.toContain('ClockCircleOutlined');
    expect(compactSection).not.toContain('status-board-card__tags');
    expect(compactSection).not.toContain('<Tag');
    expect(css).toContain('.status-board-card__compact-text');
    expect(css).toContain('white-space: nowrap');
    expect(css).toContain('text-overflow: ellipsis');
  });
});
