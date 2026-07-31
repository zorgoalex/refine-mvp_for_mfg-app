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
const columnSettings = readFileSync(
  'src/pages/orderStatusBoard/StatusBoardColumnSettings.tsx',
  'utf8',
);
const columnVisibility = readFileSync(
  'src/pages/orderStatusBoard/statusBoardColumnVisibility.ts',
  'utf8',
);
const cutApi = readFileSync(
  'src/api/cutApi.ts',
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
    expect(page).not.toContain('workday ? { date: workday } : {}');
    expect(page).toContain('<CncTelegramTodayColumns');
    expect(page).toContain("label: 'МДФ-работы'");
    expect(page).toContain("parsed: 'Файлы на станке'");
    expect(page).toContain('CncTelegramBathCardView');
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).toContain('CNC_HISTORY_DAYS = 7');
    expect(page).toContain('aria-label="Дата CNC-работ"');
    expect(page).toContain('buildCncOrderFilterOptions');
    expect(page).toContain('filterCncTodayColumnsByOrders');
    expect(page).toContain('filterCncBathColumnsByMachineOrderMatches');
    expect(page).toContain('status-board-toolbar__cnc-order-search');
    expect(page).toContain('mode="multiple"');
    expect(page).toContain('suffixIcon={<SearchOutlined />}');
    expect(page).toContain('options={cncOrderFilterOptions}');
    expect(page).toContain('aria-label="Фильтр МДФ-работ по номеру заказа"');
    expect(page).toContain('status-board-toolbar__cnc-period');
    expect(page).toContain('Период');
    expect(page).toContain('DEFAULT_CNC_ORDER_SEARCH_PERIOD');
    expect(page).toContain("label: '1нед'");
    expect(page).toContain("label: '2нед'");
    expect(page).toContain("label: '1м'");
    expect(page).toContain('aria-pressed={active}');
    expect(page).toContain('buildCncOrderSearchDateRange');
    expect(page).toContain('dateFrom: displayRange.dateFrom');
    expect(page).toContain('dateTo: displayRange.dateTo');
    expect(page).toContain('datasetKey');
    expect(page).toContain('buildCncColumnTotals(column, relationContext, detailedContext)');
    expect(page).not.toContain('buildCncDetailedDisplayColumns(columns)');
    expect(page).toContain("getCncBathRelationState(bath, relationContext) !== 'dimmed'");
    expect(page).toContain("getCncPacketDisplayState(packet, relationContext, detailedContext) !== 'dimmed'");
    expect(page).toContain('cnc-today-column__header-main');
    expect(page).toContain('cnc-today-column__totals');
    expect(page).toContain("{totals.details} дет. · {formatArea(totals.areaM2)}");
    expect(page).toContain('По выбранному заказу МДФ-работ нет');
    expect(page).toContain('В чате {formatDateTime');
    expect(page).toContain('<Collapse.Panel');
    expect(page).toContain('cncColumnDisplayTitle(column)');
    expect(page).toContain("baths: 'Карты ванн'");
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).not.toContain('Строка не сопоставлена с ERP');
    expect(page).not.toContain('items={[{');
    expect(page).not.toContain("board: 'cnc");
  });

  it('keeps bath cards printable with SVG and PDF previews', () => {
    expect(page).toContain('cutApi.fetchSheetSvg');
    expect(page).toContain('cutApi.fetchJobPdf');
    expect(page).toContain('const fetchFreshPdf = useCallback');
    expect(page).toContain('const downloadPdf = useCallback(async () =>');
    expect(page).toContain('const printPdf = useCallback(async () =>');
    expect(page).toContain('triggerBlobDownload(result.blob');
    expect(page).toContain('const freshUrl = URL.createObjectURL(result.blob)');
    expect(page).toContain("CNC_BATH_DEFAULT_PDF_TEMPLATE = 'bath_profiles'");
    expect(page).toContain('Шаблон PDF ванны');
    expect(page).toContain("import('pdfjs-dist')");
    expect(page).toContain('renderCncPdfPagePreviews(result.blob)');
    expect(page).toContain('data-testid="cnc-bath-pdf-preview-pages"');
    expect(page).not.toContain('<iframe');
    expect(page).not.toContain('triggerBlobDownload(blob, fileName');
    expect(page).not.toContain("window.open(url, '_blank')");
    expect(page).toContain('PrinterOutlined');
    expect(page).toContain('DownloadOutlined');
    expect(css).toContain('.cnc-bath-card__pdf-pages');
    expect(css).toContain('.cnc-bath-card__pdf-page-image');
    expect(css).toContain('.cnc-bath-card__ready-icon--pending');
  });

  it('keeps the completed CNC card check marker understandable', () => {
    expect(page).toContain("packet.completionStatus === 'completed'");
    expect(page).toContain('<CheckCircleOutlined />');
    expect(page).toContain('Распилено на станке');
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
    expect(page).toContain('summary.orderDeleted');
    expect(page).toContain('item.orderDeleted');
    expect(page).toContain('OrderDeletedTag');
    expect(page).toContain('ORDER_DELETED_REFERENCE_LINE_CLASS');
    expect(css).toContain('.cnc-packet-card__summary.order-deleted-reference-line');
    expect(css).toContain('.cnc-packet-card__item.order-deleted-reference-line');
    expect(page).toContain('summary.positions');
    expect(page).toContain('summary.details');
    expect(page).toContain('summary.orderId ??= item.orderId ?? item.matchOrderId ?? null');
    expect(page).toContain('const orderId = item.orderId ?? item.matchOrderId');
    expect(css).toContain('.cnc-packet-card__summaries');
    expect(css).toContain('font-size: 15px');
    expect(css).toContain('margin-bottom: 12px');
    expect(css).toContain('.cnc-packet-card__summary');
    expect(css).toContain('.cnc-packet-card__summary-order');
    expect(css).toContain('.cnc-packet-card__summary-order.ant-btn');
    expect(css).toContain('color: #1677ff');
    expect(css).toContain('.cnc-packet-card__summary-meta');
    expect(css).toContain('font-weight: 400');
    expect(css).toContain('.cnc-packet-card__program');
    expect(css).toMatch(/\.cnc-packet-card__program\s*\{[^}]*color: var\(--app-text-muted\);/);
    expect(page).toContain('packet.cuttingSequenceNo');
    expect(page).toContain('Номер раскроя файла станка');
    expect(css).toContain('.cnc-packet-card__sequence');
    expect(page).toContain('cnc-packet-card__sequence-sign');
    expect(css).toContain('.cnc-packet-card__sequence-sign');
    expect(css).toMatch(/\.cnc-packet-card__sequence\s*\{[^}]*color: #000;/);
    expect(css).toMatch(/\.cnc-packet-card__sequence-sign\s*\{[^}]*font-size: 0\.5em;/);
    expect(css).toContain('font-variant-numeric: tabular-nums');
    const cncFileNameRules = css.match(/\.cnc-packet-card__note-file\s*\{[^}]*\}/g) ?? [];
    expect(cncFileNameRules.length).toBeGreaterThan(0);
    expect(cncFileNameRules.every((rule) => rule.includes('color: var(--app-text-muted);'))).toBe(true);
  });

  it('offers compact MDF cards with per-card temporary standard view', () => {
    expect(page).toContain('type CncCardDisplayMode,');
    expect(page).toContain('const [cncCardDisplayMode, setCncCardDisplayMode]');
    expect(page).toContain('aria-label="Формат карточек МДФ-доски"');
    expect(page).toContain("label: 'Стандартные'");
    expect(page).toContain("label: 'Компактные'");
    expect(page).toContain('cardDisplayMode={cncCardDisplayMode}');
    expect(page).toContain("const cardKey = `packet:${packet.packetId}`");
    expect(page).toContain("const cardKey = `bath:${bath.bathCardId}`");
    expect(page).toContain("const cardKey = `order:${card.orderId}`");
    expect(page).toMatch(
      /isCncCardSummaryOnly\(\s*cardDisplayMode,\s*standardCardOverrides,\s*cardKey,\s*\)/,
    );
    expect(page).toContain('<CncCardDisplayToggle');
    expect(page).toContain('cncSummaryOnly={summaryOnly}');
    expect(page).toContain('Показать стандартный вид карточки');
    expect(page).toContain('Вернуть компактный вид карточки');
    expect(page).toContain("data-cnc-card-view={summaryOnly ? 'compact' : 'standard'}");
    expect(page).toContain('event.stopPropagation()');
    expect(css).toContain('.cnc-card-display-toggle.ant-btn');
    expect(css).toContain('min-width: 40px');
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('.cnc-card-display-toggle__icon');
    expect(css).toContain('scale(0.25)');
    expect(css).toContain('blur(4px)');
    expect(css).toContain('cubic-bezier(0.2, 0, 0, 1)');
    expect(css).not.toContain('transition: all');
  });

  it('tunes compact MDF hierarchy and omits position counts', () => {
    expect(page).toContain('compact: boolean;');
    expect(page).toContain('compact={summaryOnly}');
    expect(page).toContain('`${summary.details} дет.`');
    expect(page).toContain('className="cnc-order-card__compact-client"');
    expect(css).toMatch(
      /\.cnc-card--summary-only \.cnc-packet-card__summary-order[^}]*\{[^}]*font-size: 1\.2em;[^}]*color: var\(--app-text\);/s,
    );
    expect(css).toMatch(
      /\.cnc-card--summary-only \.cnc-packet-card__summary-meta\s*\{[^}]*margin-inline-start: 12px;[^}]*color: var\(--app-text-muted\);/s,
    );
    expect(css).toMatch(
      /\.cnc-order-card--summary-only \.status-board-card__number[^}]*\{[^}]*font-size: 1\.2em;[^}]*color: var\(--app-text\);/s,
    );
  });

  it('shows the bath cut-result version before readiness and removes terminal work', () => {
    const actionsStart = page.indexOf('<div className="cnc-bath-card__actions">');
    const actionsEnd = page.indexOf('</div>', actionsStart);
    const actions = page.slice(actionsStart, actionsEnd);
    expect(actions).toContain('className="cnc-bath-card__cut-result-badge"');
    expect(actions).toMatch(/>\s*\{bath\.cutNumber\}\s*<\/Tag>/);
    expect(actions).not.toContain('№{bath.cutNumber}');
    expect(actions.indexOf('cnc-bath-card__cut-result-badge')).toBeLessThan(
      actions.indexOf('cnc-bath-card__ready-icon'),
    );
    expect(css).toMatch(
      /\.cnc-bath-card__actions\s*\{[^}]*align-items: center;/s,
    );
    expect(css).toMatch(
      /\.cnc-bath-card__cut-result-badge\.ant-tag\s*\{[^}]*padding-inline: 6px;[^}]*border-radius: 4px;[^}]*font-size: 1\.2em;[^}]*font-variant-numeric: tabular-nums;/s,
    );
    expect(page).toContain('filterCncBathColumnsByOrderStatuses(');
    expect(page).toContain('!isCncOrderHiddenFromMdfBoard(card)');
  });

  it('keeps visible MDF columns fluid and switches narrow boards to order numbers only', () => {
    expect(page).not.toContain('? buildCncDetailedDisplayColumns(columns)');
    expect(css).toMatch(
      /\.status-board-columns--cnc\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(var\(--status-board-cnc-column-count, 5\), minmax\(0, 1fr\)\);/s,
    );
    expect(page).toContain("'--status-board-cnc-column-count': displayColumns.length");
    expect(css).toContain('.status-board-columns--cnc > .status-board-column');
    expect(css).toContain('container-name: status-board-viewport');
    expect(css).toContain('@container status-board-viewport (max-width: 960px)');
    expect(css).toContain('.status-board-columns--cnc .cnc-packet-card__summary-meta');
    expect(css).toContain('.status-board-columns--cnc .status-board-card__status-row');
    expect(css).toContain('.status-board-columns--cnc .cnc-order-card__compact-client');
  });

  it('prints the compact MDF board in landscape with repeated column headers', () => {
    const printCardStart = page.indexOf('const CncTelegramPrintCard');
    const printCardEnd = page.indexOf('interface CncCardDisplayToggleProps', printCardStart);
    const printCard = page.slice(printCardStart, printCardEnd);

    expect(page).toContain("import { createPortal } from 'react-dom';");
    expect(page).toContain("cncCardDisplayMode === 'compact'");
    expect(page).toContain('aria-label="Распечатать компактную МДФ-доску"');
    expect(page).toContain('onClick={() => window.print()}');
    expect(page).toContain('<CncTelegramPrintBoard');
    expect(page).toContain('card.packet.cuttingSequenceNo');
    expect(page).toContain('cnc-print-card__sequence');
    expect(page).toContain('cnc-print-card__sequence-sign');
    expect(page).toContain('const rowCount = Math.max(');
    expect(page).toContain('<thead>');
    expect(page).toContain('<th key={column.key} scope="col">');
    expect(css).toContain('@page');
    expect(css).toContain('size: A4 landscape');
    expect(css).toContain('.cnc-print-board thead');
    expect(css).toContain('.cnc-print-card__sequence');
    expect(css).toContain('.cnc-print-card__sequence-sign');
    expect(css).toMatch(/\.cnc-print-card__sequence\s*\{[^}]*color: #000;/);
    expect(css).toMatch(/\.cnc-print-card__sequence-sign\s*\{[^}]*font-size: 0\.5em;/);
    expect(css).toContain('display: table-header-group');
    expect(css).toContain('break-inside: avoid');
    expect(printCard).toContain('className="cnc-print-card__bath-cut-number"');
    expect(printCard).toContain('{card.bath.cutNumber}');
    expect(printCard).not.toContain('№{card.bath.cutNumber}');
    expect(css).toMatch(
      /\.cnc-print-card__bath-cut-number\s*\{[^}]*border-radius: 1mm;[^}]*font-variant-numeric: tabular-nums;/s,
    );
  });

  it('keeps CNC relation highlighting defaulted on and controlled by the Links switch', () => {
    expect(page).toContain('const [cncRelationsEnabled, setCncRelationsEnabled] = useState(true)');
    expect(page).toContain('const [activeCncRelation, setActiveCncRelation]');
    expect(page).toContain("| { kind: 'order'; id: number }");
    expect(page).toContain('Связи');
    expect(page).toContain('checked={cncRelationsEnabled}');
    expect(page).toContain('if (!cncRelationsEnabled) setActiveCncRelation(null)');
    expect(page).toContain('cncRelationTargetEquals(current, target) ? null : target');
    expect(page).toContain('cncRelationsEnabled');
    expect(page).toContain('? buildCncRelationContext(cncActiveColumns, cncOrderCards, activeCncRelation)');
    expect(page).toContain("key: 'orders' as const");
    expect(page).toContain("orders: 'Заказы'");
    expect(page).toContain('orderStatusBoardApi.get({');
    expect(page).toContain('orderIds: chunk');
    expect(page).toContain('CNC_ORDER_STATUS_REFRESH_MS');
    expect(page).toContain('getCncOrderRelationState');
    expect(page).toContain("onSelectRelation({ kind: 'order', id: card.orderId })");
    expect(page).toContain('openOrderOnNumber={!relationsEnabled}');
    expect(page).toContain('if (!openOrderOnNumber) return;');
    expect(page).toContain('const bathCards = relationContext');
    expect(page).toContain('const packetCards = relationContext');
    expect(page).toContain('sortCncRelationCards');
    expect(page).toContain('getCncPacketRelationState');
    expect(page).toContain('getCncBathRelationState');
    expect(page).toContain("'order-mentioned'");
    expect(page).toContain('CNC_OTHER_MATERIAL_MARKER_PATTERN');
    expect(page).toContain('orderKeys: Set<string>');
    expect(page).toContain('mentionedOrderKeys: Set<string>');
    expect(page).toContain('addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId, item.matchOrderId)');
    expect(page).toContain('addCncOrderRelationKeys(fingerprint, item.orderName, item.orderId)');
    expect(page).toContain('cncPacketTitleCommentOrderKeys(packet)');
    expect(page).toContain('cncWholeOrderCommentOrderKeys');
    expect(page).toContain('cncMentionedOrderKeysIntersect');
    expect(page).toContain('packetMentionedOrderMatch && cncPacketHasOtherMaterialMarker(packet)');
    expect(page).toContain('right.orderKeys.has(orderKey)');
    expect(page).toContain('event.stopPropagation()');
    expect(css).toContain('.cnc-relation-card--dimmed');
    expect(css).toContain('.cnc-relation-card--order-mentioned');
    expect(css).toContain('border-color: #fa541c');
    expect(css).toContain('0 0 0 2px #fa541c');
    expect(css).toContain('filter: grayscale(0.9)');
    expect(css).toContain('opacity: 0.62');
    expect(css).toContain('.cnc-today-column--parsed');
    expect(css).toContain('.cnc-today-column--completed');
    expect(css).toContain('background: #edf7ff');
    expect(css).toContain('.cnc-today-column--baths');
    expect(css).toContain('.cnc-today-column--baths_ready');
    expect(css).toContain('background: #fff7e6');
    expect(css).toContain('.status-board-columns--cnc > .status-board-column');
    expect(css).toContain(
      'grid-template-columns: repeat(var(--status-board-cnc-column-count, 5), minmax(0, 1fr))',
    );
    expect(css).toContain('.cnc-today-column__header-main');
    expect(css).toContain('.cnc-today-column__totals');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('border-color: #722ed1');
    expect(css).toContain('0 0 0 2px #722ed1');
    expect(css).not.toContain('transition: all');
  });

  it('gives every board its own personal column settings gear', () => {
    expect(page).toContain('<StatusBoardColumnSettingsButton');
    expect(page).toContain('STATUS_BOARD_COLUMN_PREFERENCE_KEYS[viewState.view]');
    expect(page).toContain('STATUS_BOARD_COLUMN_PREFERENCE_KEYS.cnc_today');
    expect(page).toContain('filterVisibleStatusBoardColumns(');
    expect(page).toContain('showOrdersColumn={cncOrdersColumnVisible}');
    expect(columnVisibility).toContain("order: 'statusBoardOrder'");
    expect(columnVisibility).toContain("production: 'statusBoardProduction'");
    expect(columnVisibility).toContain("cnc_today: 'statusBoardCnc'");
    expect(columnVisibility).toContain("{ key: 'orders', label: 'Заказы' }");
    expect(columnSettings).toContain('Настройка применяется только для вашей учётной записи.');
    expect(columnSettings).toContain('Настроить колонки доски');
    expect(columnSettings).toContain('<Checkbox');
    expect(columnSettings).toContain('Сохраняется автоматически');
    expect(css).toMatch(
      /\.status-board-toolbar__settings-button\.ant-btn\s*\{[^}]*width: 40px;[^}]*height: 40px;[^}]*margin-left: auto;/s,
    );
  });

  it('keeps CNC display modes in its single gear with bath-file filtering on by default', () => {
    expect(page).toContain('extraContent={cncSettingsContent}');
    expect(page).toContain('status-board-settings__modes');
    expect(page).toContain('const [cncBathsRequireMachineFiles, setCncBathsRequireMachineFiles] =');
    expect(page).toContain('useState(true)');
    expect(page).toContain('Ванны с файлами');
    expect(page).toContain('checked={cncBathsRequireMachineFiles}');
    expect(page).toContain('filterCncBathColumnsByMachineOrderMatches(cncOrderFilteredColumns)');
    expect(css).toContain('.status-board-toolbar__settings-button.ant-btn');
    expect(css).toContain('margin-left: auto');
    expect(css).toContain('.status-board-settings__modes');
  });

  it('keeps CNC detailed bath mode explicit and clickable by SVG detail metadata', () => {
    expect(page).toContain('const [cncDetailedEnabled, setCncDetailedEnabled] = useState(false)');
    expect(page).toContain('const [activeCncDetailedBathId, setActiveCncDetailedBathId]');
    expect(page).toContain('const [activeCncDetailedDetail, setActiveCncDetailedDetail]');
    expect(page).toContain('Подробный');
    expect(page).toContain('checked={cncDetailedEnabled}');
    expect(page).toContain('buildCncDetailedContext');
    expect(page).toContain('detailedContext={cncDetailedContext}');
    expect(page).toContain('onSelectDetailedBath={selectCncDetailedBath}');
    expect(page).toContain('onCloseDetailedBath={closeCncDetailedBath}');
    expect(page).toContain('onSelectDetailedDetail={selectCncDetailedDetail}');
    expect(page).toContain('data-cnc-detailed-state');
    expect(page).toContain('Свернуть подробный вид ванны');
    expect(page).toContain('detailed ? false : true');
    expect(page).toContain('buildCncBathDetailOrderFillMap');
    expect(page).toContain('CNC_BATH_DETAIL_ORDER_FILL_COLORS');
    expect(page).toContain("rect.setAttribute('fill', fill)");
    expect(page).toContain("rect.setAttribute('data-cnc-order-fill', 'true')");
    expect(page).toContain('enlargeCncBathDetailText(piece, 2)');
    expect(page).toContain("text.setAttribute('data-cnc-detailed-font-scale'");
    expect(page).toContain('cncBathDetailCheckPoint');
    expect(page).toContain('cncClampSvgCoordinate');
    expect(cutApi).toContain('pieceMetadata');
    expect(cutApi).toContain("params.append('pieceMetadata', 'on')");
    expect(page).toContain('decorateCncBathSheetSvg');
    expect(page).toContain('data-detail-id');
    expect(page).toContain('cnc-bath-detail-check');
    expect(page).toContain('getCncPacketDisplayState');
    expect(page).toContain('cncDetailFingerprintsIntersect');
    expect(page).toContain('cncPacketWholeOrderIntersects');
    expect(css).toContain('.status-board-columns--cnc-detailed .cnc-today-column--detailed');
    expect(css).toContain('.status-board-columns--cnc-detailed .cnc-today-column--parsed');
    expect(css).toContain(
      'grid-template-columns: repeat(var(--status-board-cnc-column-count, 5), minmax(0, 1fr));',
    );
    expect(css).toContain('.cnc-bath-card--detailed');
    expect(css).toContain('width: 100%;');
    expect(css).toContain('margin-left: 0;');
    expect(css).toContain('isolation: isolate');
    expect(css).toContain('font-size: 10px');
    expect(css).toContain('.cnc-bath-card__detail-close');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-detail-id]');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-cnc-order-fill="true"]');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-cnc-selected-detail="true"] > rect:first-child');
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
    const compactStart = page.indexOf('{showCompactDetails && !showStandardDetails && !cncSummaryOnly && (');
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
