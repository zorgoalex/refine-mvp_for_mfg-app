import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(
  'src/pages/orderStatusBoard/OrderStatusBoardPage.tsx',
  'utf8',
);
const model = readFileSync('src/pages/orderStatusBoard/model.ts', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const siderMenuItems = readFileSync('src/utils/siderMenuItems.ts', 'utf8');
const customSider = readFileSync('src/components/CustomSider.tsx', 'utf8');
const cncTelegramApi = readFileSync('src/api/cncTelegramApi.ts', 'utf8');
const orderStatusBoardApi = readFileSync('src/api/orderStatusBoardApi.ts', 'utf8');
const css = readFileSync(
  'src/pages/orderStatusBoard/orderStatusBoard.css',
  'utf8',
);
const operationalCss = readFileSync('src/ui-operational/operational.css', 'utf8');
const tabletCss = readFileSync('src/ui-evolution/styles/tablet.css', 'utf8');
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
const touchDrag = readFileSync(
  'src/pages/orderStatusBoard/useTouchBoardCardDrag.tsx',
  'utf8',
);
const detailedMachine = readFileSync(
  'src/pages/orderStatusBoard/cncDetailedMachine.ts',
  'utf8',
);
const mdfSheetPreview = readFileSync(
  'src/pages/orderStatusBoard/cncMdfSheetPreview.ts',
  'utf8',
);
const imagePrintPreview = readFileSync(
  'src/components/ImagePrintPreviewModal.tsx',
  'utf8',
);
const pdfPreview = readFileSync(
  'src/pages/orderStatusBoard/cncPdfPreview.ts',
  'utf8',
);

describe('OrderStatusBoardPage UX guards', () => {
  it('defers optional MDF PDF and label tooling until the operator opens it', () => {
    expect(page).not.toContain("new URL('pdfjs-dist/build/pdf.worker.min.mjs'");
    expect(page).not.toContain("import('pdfjs-dist')");
    expect(page).toContain("await import('./cncPdfPreview')");
    expect(page).toContain("await import('../cut/CutSheetLabelGenerateAction')");
    expect(page).toContain('<Suspense fallback={<CncLabelActionLoadingButton />}>');
  });

  it('keeps status-board drag and column helpers bound after branch merges', () => {
    expect(page).toContain("export type CncOrderSortField =");
    expect(page).toContain("export type CncOrderSortDirection = 'asc' | 'desc';");
    expect(page.match(/export type CncManualCardKind =/g)).toHaveLength(1);
    expect(page).toContain('finePointer={finePointer}');
    expect(page).toContain('finePointer: boolean;');
    expect(page).toContain('if (isCncBathColumnKey(columnKey))');
    expect(page).toContain('if (isCncOrderColumnKey(columnKey))');
    expect(page).not.toContain('isCncBathColumn(columnKey)');
    expect(page).not.toContain('isCncOrderColumn(columnKey)');
  });

  it('keeps keyboard move, live announcements and focus restoration', () => {
    expect(page).toContain('cardRef.current');
    expect(page).toContain('function isKeyboardMoveMenuTrigger');
    expect(page).toContain('onKeyDown={(event) =>');
    expect(page).toContain("aria-haspopup={moveAvailable ? 'menu' : undefined}");
    expect(page).toContain('aria-expanded={moveAvailable ? menuOpen : undefined}');
    expect(page).toContain('setMenuOpen(true)');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('aria-describedby');
    expect(page).toContain('restoreOrderStatusBoardFocus');
    expect(page).toContain('data-status-board-order-id');
    expect(page).toContain('cardRef.current');
    expect(page).toContain('function isKeyboardMoveMenuTrigger');
    expect(page).toContain('onKeyDown={(event) =>');
    expect(page).toContain("aria-haspopup={moveAvailable ? 'menu' : undefined}");
    expect(page).toContain('aria-expanded={moveAvailable ? menuOpen : undefined}');
    expect(page).toContain('setMenuOpen(true)');
  });

  it('moves production cards without the obsolete manual-mode confirmation', () => {
    expect(page).not.toContain('Перевести заказ в ручной режим?');
    expect(page).not.toContain('отключит авторасчёт');
    expect(page).not.toContain('confirmManualProductionMove');
    expect(interaction).not.toContain('confirmManualProductionMove');
    expect(interaction).not.toContain("kind: 'cancelled'");
  });

  it('keeps regular status DnD guarded and MDF manual drag touch-capable', () => {
    expect(page).toContain("import { TouchBackend } from 'react-dnd-touch-backend'");
    expect(page).toContain('useDragLayer');
    expect(page).toContain('enableMouseEvents: true');
    expect(page).toContain('delayTouchStart');
    expect(page).toContain('delayTouchStart: 420');
    expect(page).toContain('const finePointer = !touchBoardDragEnabled');
    expect(page).toContain('canDrag: () => moveAvailable && finePointer && !dragSuppressedRef.current');
    expect(page).toContain('CNC_BOARD_DRAG_TYPE');
    expect(page).toContain('CncBoardDragLayer');
    expect(page).toContain('buildCncDragPreview');
    expect(page).toContain('monitor.getSourceClientOffset()');
    expect(page).toContain('className="cnc-board-drag-outline"');
    expect(page).toContain('CncManualCardFrame');
    expect(page).toContain('isCncManualMoveAllowed(item.kind, columnKey)');
    expect(page).toContain('includeTerminalManualMoves: terminalColumnsVisible');
    expect(page).toContain('applyCncManualMovesToColumns(readinessColumns, manualMoves)');
    expect(page).toContain('orderStatusBoardApi.listMdfManualMoves');
    expect(page).toContain('orderStatusBoardApi.upsertMdfManualMove');
    expect(page).toContain('fetchCncManualMoves');
    expect(page).not.toContain('erp.statusBoard.cncManualMoves');
    expect(page).not.toContain('loadCncManualMoves');
    expect(page).not.toContain('saveCncManualMoves');
    expect(page).toContain('kind="bazisCutSet"');
    expect(page).toContain('completed_laminated');
    expect(page).not.toContain('cncOrderStatusBadgeOverride');
    expect(page).not.toContain('statusBadgeOverride');
    expect(page).toContain('primaryStatusKind="order"');
    expect(page).toContain("label: 'Переместить'");
    expect(page).toContain('trigger={[');
    expect(page).toContain('trigger: shellRef.current');
    expect(page).toContain('trigger: cardRef.current');
    expect(page).toContain('dragRef(node)');
    expect(page).toContain('isCncManualDragIgnored(event.target)');
    expect(page).not.toContain('CncCardMoveActions');
    expect(page).not.toContain('cncMoveControls');
    expect(page).not.toContain('DragOutlined');
    expect(page).not.toContain('MoreOutlined');
    expect(page).toContain('const touchBoardDragEnabled = useCoarsePointer()');
    expect(page).toContain('touchDragEnabled={touchBoardDragEnabled}');
    expect(page).toContain('touchDragEnabled={mutationsEnabled && touchDragEnabled}');
    expect(page).toContain('touchDragEnabled = false');
    expect(touchDrag).toContain("event.pointerType !== 'touch'");
    expect(touchDrag).toContain('handle.setPointerCapture');
    expect(touchDrag).toContain('setReady(true)');
    expect(touchDrag).toContain('ready,');
    expect(touchDrag).toContain('navigator.vibrate?.(18)');
    expect(touchDrag).toContain('document.elementFromPoint');
    expect(page).toContain('data-status-board-column-key={column.key}');
    expect(page).toContain('status-board-touch-drag-instructions');
    expect(page).not.toContain('touchDragEnabled={false}');
    expect(css).toContain('.cnc-board-card-shell--draggable');
    expect(css).toContain('.status-board-card--touch-ready');
    expect(css).toContain('.cnc-board-card-shell--touch-ready > .status-board-card');
    expect(css).toContain('@keyframes statusBoardTouchReadyWiggle');
    expect(css).toContain('.cnc-board-drag-outline');
    expect(css).toMatch(/\.cnc-board-drag-outline\s*\{[^}]*position: fixed;[^}]*pointer-events: none;[^}]*border: 2px dashed var\(--status-color, #1677ff\);/s);
    expect(css).not.toContain('.cnc-card-move-actions');
    expect(css).toMatch(/\.cnc-board-card-shell--draggable\s*\{[^}]*touch-action: pan-x pan-y;/s);
    expect(page).toContain('touchDragLockedRef.current = true');
    expect(page).toContain("document.addEventListener('touchmove', preventTouchScroll");
    expect(page).toContain("document.removeEventListener('touchmove', preventTouchScroll, true)");
    const manualFrameStart = page.indexOf('const CncManualCardFrame: React.FC<CncManualCardFrameProps>');
    const manualFrameEnd = page.indexOf('interface CncDetailedMachineMapsProps', manualFrameStart);
    const manualFrame = page.slice(manualFrameStart, manualFrameEnd);
    const lockedTouchMoveStart = manualFrame.indexOf('if (touchDragLockedRef.current) {');
    const lockedTouchMoveEnd = manualFrame.indexOf('const deltaX', lockedTouchMoveStart);
    const lockedTouchMove = manualFrame.slice(lockedTouchMoveStart, lockedTouchMoveEnd);
    const preventTouchScrollStart = manualFrame.indexOf('const preventTouchScroll = (event: TouchEvent) => {');
    const preventTouchScrollEnd = manualFrame.indexOf('document.addEventListener', preventTouchScrollStart);
    const preventTouchScroll = manualFrame.slice(preventTouchScrollStart, preventTouchScrollEnd);
    expect(lockedTouchMove).toContain('event.preventDefault()');
    expect(preventTouchScroll).toContain('event.preventDefault()');
    expect(lockedTouchMove).not.toContain('event.stopPropagation()');
    expect(preventTouchScroll).not.toContain('event.stopPropagation()');
    expect(page).toContain("touchReady ? 'cnc-board-card-shell--touch-locked' : ''");
    expect(page).toContain("import { touchBoardEdgeScrollDelta } from './touchBoardDrag'");
    expect(page).toContain('const startTouchDragAutoScroll = useCallback((handle: HTMLElement) => {');
    expect(page).toContain('viewport.scrollLeft += touchBoardEdgeScrollDelta(');
    expect(page).toContain('cards.scrollTop += touchBoardEdgeScrollDelta(');
    expect(page).toContain('startTouchDragAutoScroll(handle)');
    expect(css).toMatch(/\.cnc-board-card-shell--touch-locked,[\s\S]*?touch-action: none !important;/);
    expect(css).toContain('.status-board-viewport--touch-dragging');
    expect(css).toContain('scroll-snap-type: none');
    expect(css).toMatch(/\.status-board-viewport--touch-dragging\s*\{[^}]*touch-action: none !important;/s);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('scroll-snap-type: x mandatory');
    expect(css).toContain('touch-action: pan-y');
  });

  it('opens the dedicated MDF work board on today unless a card deep-link provides its workday', () => {
    expect(page).toContain("const todayCncWorkday = dayjs().format('YYYY-MM-DD');");
    expect(page).toContain("active && fixedView === 'cnc_today' && !mdfWorkdayOpenSyncedRef.current");
    expect(page).toContain('const hasExplicitMdfCardDeepLink = Boolean(');
    expect(page).toMatch(/mdfWorkdayTodayOpenPatchNeeded\s*=\s*[\s\S]*?!hasExplicitMdfCardDeepLink/);
    expect(page).toContain('filterCncBathColumnsByMachineOrderMatches(cncOrderFilteredColumns, preservedCncBathCardId)');
    expect(page).toContain('const deepLinkFocusAppliedRef = useRef<string | null>(null);');
    expect(page).toContain('if (deepLinkFocusAppliedRef.current === key) return undefined;');
    expect(page).toContain('deepLinkFocusAppliedRef.current = key;');
    expect(page.indexOf('deepLinkFocusAppliedRef.current = key;')).toBeLessThan(page.indexOf('target.focus({ preventScroll: true });'));
    expect(page).toContain('updateViewState({ cncWorkday: todayCncWorkday, cncOrderFilters: [] });');
    expect(page).toContain('if (mdfWorkdayTodayOpenPatchNeeded) return;');
    expect(page).toContain('<OrderStatusBoardPage active={active} fixedView="cnc_today" defaultCncOrderSearchPeriod="1m" />');
  });

  it('shows click help icons explaining how cards leave columns', () => {
    expect(page).toContain('QuestionCircleOutlined');
    expect(page).toContain('function StatusBoardColumnHelpButton');
    expect(page).toContain('trigger="click"');
    expect(page).toContain('help={cncColumnLeaveHelp(column.key)}');
    expect(page).toContain('help={statusColumnLeaveHelp(column.status.name)}');
    expect(page).toContain('Когда ванна уходит из колонки');
    expect(page).toContain('Когда заказ уходит из колонки');
    expect(page).toContain('Если статус заказа стал «Готов к выдаче»');
    expect(page).toContain('Если статус заказа стал «Выдан»');
    expect(page).toContain('Кнопка «Обновить» и автообновление доски заново проверяют статус');
    expect(css).toContain('.status-board-column-help__trigger.ant-btn');
    expect(css).toContain('.status-board-column-help__list li + li');
  });

  it('refreshes MDF order statuses and forces status-owned order columns', () => {
    expect(page).toContain('const refreshedOrderIds = collectCncOrderStatusBoardIds(');
    expect(page).toContain('startTransition(() => setCncOrderBoard(orderBoardResponse));');
    expect(page).toContain('function collectCncOrderStatusBoardIds(');
    expect(page).toContain('resolveCncOrderStatusColumn(card) === null');
    expect(page).toContain('const statusColumn = resolveCncOrderStatusColumn(card);');
    expect(page).toContain("if (statusName === 'выдан') return 'orders_issued';");
    expect(page).toContain("if (statusName === 'готов к выдаче') return 'orders_ready';");
  });

  it('keeps order status badge in the header and overdue as a clock icon', () => {
    expect(page).toContain('status-board-card__identity');
    expect(page).toContain('status-board-card__status-badge');
    expect(page).toContain('status-board-card__overdue-icon');
    expect(page).toContain('aria-label="Плановая дата прошла"');
    expect(page).not.toContain('<Tag color="blue">Авто</Tag>');
    expect(page).not.toContain('<Tag color="volcano">Плановая дата прошла</Tag>');
    expect(css).toContain('.status-board-card__identity');
    expect(css).toContain('.status-board-card__overdue-icon');
    expect(css).toContain('color: #cf1322');
  });

  it('keeps tablet board actions compact and MDF controls under the thin disclosure', () => {
    expect(page).toContain('className="status-board-toolbar__tablet-board-switch"');
    expect(page).toContain('aria-label="Переключатель досок"');
    expect(page).toContain('className="status-board-toolbar__tablet-refresh"');
    expect(page).toContain('className="status-board-toolbar__cnc-card-mode-text"');
    expect(tabletCss).toMatch(/data-modern-route="status-board"[^}]+\.status-board-toolbar \{[\s\S]*height: var\(--tablet-sticky-row\);/);
    expect(tabletCss).toContain('--status-board-cnc-mobile-spoiler-row: 34px;');
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc\s*\{[^}]*min-height: var\(--status-board-cnc-mobile-spoiler-row\);[^}]*flex: 0 0 auto;[^}]*overflow: clip;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__toggle\s*\{[^}]*height: var\(--status-board-cnc-mobile-spoiler-row\);[^}]*padding: 0 10px;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content\s*\{[^}]*grid-template-rows: 0fr;[^}]*visibility: hidden;[^}]*opacity: 0;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc\.status-board-toolbar-disclosure--expanded \.status-board-toolbar-disclosure__content\s*\{[^}]*grid-template-rows: 1fr;[^}]*visibility: visible;[^}]*opacity: 1;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc \.status-board-toolbar\s*\{[^}]*position: static;[^}]*height: auto;[^}]*flex-wrap: wrap;/s,
    );
    expect(tabletCss).toContain('.status-board-toolbar__tablet-board-switch .ant-segmented-item');
    expect(tabletCss).toContain('.status-board-toolbar__cnc-card-mode-text');
    expect(tabletCss).toContain('scrollbar-width: none');
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-viewport\s*\{[^}]*height: auto;[^}]*overflow-x: auto;[^}]*overflow-y: auto;/s,
    );
    expect(tabletCss).toMatch(/\.evolution-shell--tablet \.status-board-scrollbar \{\s*display: none;/);
    expect(tabletCss).toContain('overscroll-behavior-x: auto');
    expect(tabletCss).toContain('touch-action: pan-x pan-y');
    expect(tabletCss).toContain('scroll-snap-type: x proximity');
  });

  it('collapses mobile board controls and keeps MDF mobile columns denser', () => {
    expect(page).toContain('const StatusBoardToolbarDisclosure');
    expect(page).toContain('aria-expanded={expanded}');
    expect(page).toContain('setMobileToolbarExpanded((current) => !current)');
    expect(page).toContain('setMobileToolbarExpanded(true)');
    expect(page).toContain("cncStandardColumnLayout ? 'status-board-columns--cnc-standard' : ''");
    expect(css).toContain('.status-board-toolbar-disclosure__toggle');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('.status-board-page--cnc .status-board-toolbar-disclosure__toggle');
    expect(css).toContain('height: 34px');
    expect(css).toContain('.status-board-page--cnc .status-board-toolbar-disclosure__summary');
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content\s*\{[^}]*display: grid;[^}]*grid-template-rows: 0fr;[^}]*visibility: hidden;[^}]*opacity: 0;/s,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content-inner\s*\{[^}]*min-height: 0;[^}]*display: block;[^}]*overflow: hidden;/s,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc\.status-board-toolbar-disclosure--expanded \.status-board-toolbar-disclosure__content\s*\{[^}]*grid-template-rows: 1fr;[^}]*visibility: visible;[^}]*opacity: 1;/s,
    );
    expect(css).toContain('grid-template-rows: 0fr');
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('transition-property: grid-template-rows, opacity, visibility');
    expect(css).toContain('.status-board-page--cnc .status-board-columns--cnc:not(.status-board-columns--cnc-detailed)');
    expect(css).toContain('--status-board-cnc-column-width: calc(187px * var(--status-board-cnc-mobile-column-scale, 1))');
    expect(css).toContain('--status-board-cnc-column-width: calc(112px * var(--status-board-cnc-mobile-column-scale, 1))');
    expect(css).toContain('min-width: 100% !important');
    expect(page).toContain("'var(--status-board-cnc-column-width, 220px)'");
    expect(css).not.toContain('min-width: 200%');
    expect(tabletCss).toContain('.status-board-columns--cnc-standard:not(.status-board-columns--cnc-detailed)');
    expect(tabletCss).toContain('clamp(480px, 48vw, 552px)');
  });

  it('passes horizontal phone swipes from card lists to the board viewport', () => {
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.status-board-column__cards \{[^}]*overscroll-behavior-x: auto;[^}]*overscroll-behavior-y: contain;[^}]*touch-action: pan-x pan-y;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.status-board-page--cnc \.status-board-viewport\s*\{[^}]*overscroll-behavior-x: contain;[^}]*overscroll-behavior-y: auto;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.status-board-page--cnc \.status-board-column__cards\s*\{[^}]*overscroll-behavior-y: auto;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.status-board-page--cnc \.status-board-columns--cnc:not\(\.status-board-columns--cnc-detailed\) > \.status-board-column\s*\{[^}]*overflow: visible;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\) \{[\s\S]*?\.status-board-page--cnc \.status-board-columns--cnc:not\(\.status-board-columns--cnc-detailed\) \.status-board-column__header\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: 18;[^}]*border-radius: 7px 7px 0 0;/,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc :where\([\s\S]*?\.status-board-viewport,[\s\S]*?\.cnc-board-card-shell,[\s\S]*?\.cnc-board-card-shell--draggable,[\s\S]*?\.status-board-card,[\s\S]*?\.cnc-bath-card[\s\S]*?\)\s*\{[^}]*touch-action: pan-x pan-y;/s,
    );
    expect(page).toContain('const CncPinchZoomImage');
    expect(page).toContain('data-cnc-manual-drag-ignore="true"');
    expect(page).toContain('onTouchMove={handleTouchMove}');
    expect(page).toContain('viewport.addEventListener(\'touchmove\', preventNativeScroll, { passive: false })');
    expect(css).toMatch(/\.cnc-pinch-zoom\s*\{[^}]*touch-action: pan-x pan-y;/s);
    expect(css).toMatch(/\.cnc-pinch-zoom\[data-gesture-active="true"\],[\s\S]*?\.cnc-pinch-zoom\[data-zoomed="true"\]\s*\{[^}]*touch-action: none;/s);
    expect(css).toContain('transition-property: transform;');
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-viewport\s*\{[^}]*overflow-x: auto;[^}]*overflow-y: auto;[^}]*touch-action: pan-x pan-y;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-columns--cnc\s*\{[^}]*height: auto;[^}]*min-height: 100%;[^}]*align-items: start;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-columns--cnc > \.status-board-column\s*\{[^}]*height: auto !important;[^}]*min-height: 100%;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-column__cards\s*\{[^}]*max-height: none;[^}]*overflow-y: visible;/s,
    );
    expect(page).toContain('delayTouchStart: 420');
    expect(page).toContain('touchSlop: 12');
    expect(page).toContain('{...touchDragHandleProps}');
    expect(css).not.toContain('.status-board-card__drag--touch');
  });

  it('focuses and reveals a card after a successful touch move', () => {
    expect(page).toContain('const revealTouchMovedCardRef = useRef(false)');
    expect(page).toContain('revealTouchMovedCardRef.current = revealTouchMovedCard');
    expect(page).toContain('onMove(card, destination.statusId, destination.statusName, trigger, true)');
    expect(page).toContain('revealOrderStatusBoardCard(');
    expect(page).toContain("movedCard.closest<HTMLElement>('.status-board-column__cards')");
    expect(page).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(page).not.toContain('movedCard.scrollIntoView({');
    expect(interaction).toContain('viewport.scrollTo({ left: targetLeft, behavior })');
    expect(interaction).toContain('cards.scrollTo({ top: targetTop, behavior })');
    expect(css).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.status-board-card:focus \{[^}]*outline: 2px solid #1677ff;/);
  });

  it('keeps only tabs and the settings disclosure in the mobile board header', () => {
    expect(page).toContain('label="Настройки доски"');
    expect(page).toContain('label="Настройки МДФ"');
    expect(page.match(/className="status-board-toolbar__tablet-refresh"/g)).toHaveLength(2);
    expect(page).toContain('className="status-board-toolbar__mobile-add-bath"');
    expect(css).toContain('.status-board-page > .operational-page-head');
    expect(css).toContain('.status-board-page > .status-board-page__header');
    expect(css).toMatch(/\.status-board-page > \.status-board-page__header\s*\{\s*display: none;/);
    expect(css).toContain('.status-board-toolbar__tablet-refresh.ant-btn');
    expect(css).toContain('.status-board-toolbar__mobile-add-bath.ant-btn');
    expect(css).toContain('.status-board-tabs .ant-tabs-tab');
  });

  it('keeps the upper scrollbar synchronized with the board viewport', () => {
    expect(page).toContain('topScrollbarTrack.style.width');
    expect(page).toContain('scrollBoardFromTop');
    expect(page).toContain('scrollTopFromBoard');
    expect(page).toContain('aria-controls="status-board-viewport"');
    expect(css).toContain('.status-board-scrollbar');
    expect(css).toContain('overflow-x: auto');
  });

  it('keeps order-card relation selection in place and scrolls other relation selections to top', () => {
    expect(page).toContain('function scrollStatusBoardColumnCardsToTop');
    expect(page).toContain("viewport.closest<HTMLElement>('.status-board-page')");
    expect(page).toContain("block: 'start'");
    expect(page).toContain("inline: 'nearest'");
    expect(page).toContain("viewport.scrollTo({ top: 0, behavior: 'smooth' })");
    expect(page).toContain("querySelectorAll<HTMLElement>('.status-board-column__cards')");
    expect(page).toContain("cardList.scrollTo({ top: 0, behavior: 'smooth' })");
    expect(page).toContain("activeCncRelation.kind === 'order'");
    expect(page).toContain('const sortedOrderCards = deferOverflowCards');
    expect(page).toContain('scrollStatusBoardColumnCardsToTop(boardViewportRef.current)');
    expect(page).toContain('[activeCncRelation, cncRelationsEnabled, isCncToday]');
  });

  it('loads the next column page before vertical scroll reaches the bottom', () => {
    expect(page).toContain('const loadSentinelRef = useRef<HTMLDivElement | null>(null)');
    expect(page).toContain("rootMargin: '0px 0px 320px 0px'");
    expect(page).toContain('root,');
    expect(page).toContain('observer.observe(sentinel)');
    expect(page).toContain('requestedCursorRef.current === cursor');
    expect(page).toContain('aria-busy={loadingMore}');
    expect(page).toContain('Загружаем следующие заказы…');
    expect(page).toContain("autoLoadFailed ? 'Повторить загрузку' : 'Загрузить ещё'");
    expect(css).toContain('.status-board-column__load-sentinel');
    expect(css).toContain('font-variant-numeric: tabular-nums');
  });

  it('keeps desktop MDF order columns sticky inside the pannable board viewport', () => {
    expect(page).toContain("isCncToday ? ' status-board-page--cnc' : ''");
    expect(page).toContain('function useWorkspaceTabsHeight(): number');
    expect(page).toContain("document.querySelector('.workspace-tabs')");
    expect(page).toContain("style={statusBoardPageStyle}");
    expect(page).toContain("'--status-board-toolbar-sticky-top': `${workspaceTabsHeight}px`");
    expect(page).toContain('className="status-board-toolbar-disclosure--cnc"');
    expect(css).toMatch(
      /\.status-board-page\.status-board-page--cnc\s*\{[^}]*height: calc\(100dvh - 132px\);[^}]*overflow: hidden;/s,
    );
    expect(operationalCss).toMatch(
      /\.evolution-shell__content\[data-modern-route="status-board"\] \.status-board-page\.status-board-page--cnc\s*\{[^}]*height: 100%;[^}]*overflow: hidden;/s,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc\s*\{[^}]*position: sticky;[^}]*top: var\(--status-board-toolbar-sticky-top, 0px\);[^}]*z-index: 48;/s,
    );
    expect(css).toContain('.status-board-page--cnc .status-board-toolbar-disclosure--cnc .status-board-toolbar--cnc');
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content,[\s\S]*?\.status-board-page--cnc \.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content-inner\s*\{[^}]*display: block;/s,
    );
    expect(tabletCss).toContain('.status-board-toolbar-disclosure--cnc');
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc\s*\{[^}]*min-height: var\(--status-board-cnc-mobile-spoiler-row\);[^}]*flex: 0 0 auto;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-toolbar-disclosure--cnc \.status-board-toolbar-disclosure__content\s*\{[^}]*grid-template-rows: 0fr;[^}]*visibility: hidden;[^}]*opacity: 0;/s,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-viewport\s*\{[^}]*flex: 1 1 auto;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/s,
    );
    expect(css).toMatch(
      /\.status-board-page--cnc \.status-board-column__cards\s*\{[^}]*overflow-y: visible;/s,
    );
    expect(css).toContain('--status-board-cnc-order-cards-max-height');
    expect(css).toMatch(
      /\.status-board-page--cnc \.cnc-today-column--orders \.status-board-column__cards,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_ready \.status-board-column__cards,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_issued \.status-board-column__cards\s*\{[^}]*max-height: var\(--status-board-cnc-order-cards-max-height\);[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/s,
    );
    expect(page).not.toContain('interface CncOrderColumnViewportFrame');
    expect(page).not.toContain('syncOrderColumnViewportFrame');
    expect(page).not.toContain('window.visualViewport?.addEventListener');
    expect(css).not.toContain('--status-board-cnc-order-column-offset-y');
    expect(css).not.toContain('--status-board-cnc-order-column-visual-height');
    expect(css).toMatch(
      /\.status-board-page--cnc \.cnc-today-column--orders,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_ready,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_issued\s*\{[^}]*position: sticky;[^}]*top: 4px;[^}]*align-self: start;[^}]*\}/s,
    );
    expect(css).not.toContain('translateY(var(--status-board-cnc-order-column-offset-y))');
    expect(css).not.toContain('will-change: transform');
    expect(page).toContain('type CncOrderDisplayColumnKey = Extract<');
    expect(page).toContain('orderColumnScrollTopState');
    expect(page).toContain('syncOrderColumnScrollTopButton(orderColumnKey, event.currentTarget)');
    expect(page).toContain('scrollOrderColumnToTop(columnKey, event.currentTarget)');
    expect(page).toContain('className="cnc-order-column-scroll-top"');
    expect(page).toContain('style={{ left: scrollTopButton.left }}');
    expect(page).toContain('Прокрутить колонку «${title}» наверх');
    expect(css).toContain('.cnc-order-column-scroll-top.ant-btn');
    expect(css).toContain('padding-bottom: calc(clamp(3px, 0.65vw, 10px) + 52px)');
    expect(css).toContain('position: fixed');
    expect(css).toContain('inset-block-end: calc(14px + env(safe-area-inset-bottom, 0px))');
    expect(css).toContain('height: 40px');
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('background: rgba(17, 24, 39, 0.66)');
    expect(css).toContain('transform: translateX(-50%) scale(0.96)');
    expect(page).toContain('function statusBoardHorizontalScrollEdges');
    expect(page).toContain("type CncBoardHorizontalScrollDirection = 'left' | 'right';");
    expect(page).toContain('type CncBoardHorizontalScrollEdges = Record<CncBoardHorizontalScrollDirection, boolean>');
    expect(page).toContain('targetLeft?: number');
    expect(page).toContain('const effectiveLeft = targetLeft ?? viewport.scrollLeft');
    expect(page).toContain('left: effectiveLeft > 2');
    expect(page).toContain('right: effectiveLeft < maxLeft - 2');
    expect(page).toContain('const cncBoardScrollTargetLeftRef = useRef<number | null>(null)');
    expect(page).toContain('const cncBoardScrollButtonScrollActiveRef = useRef(false)');
    expect(page).toContain('if (cncBoardScrollButtonScrollActiveRef.current) {');
    expect(page).toContain('const reachedTarget =');
    expect(page).toContain('const scrollEdgesTargetLeft = reachedTarget ? undefined : targetLeft ?? undefined');
    expect(page).toContain('const [cncBoardScrollEdges, setCncBoardScrollEdges] =');
    expect(page).toContain('setCncBoardScrollEdges(');
    expect(page).toContain('cncBoardScrollButtonScrollActiveRef.current = true');
    expect(page).toContain('cncBoardScrollButtonScrollActiveRef.current = false');
    expect(page).toContain('cncBoardScrollTargetLeftRef.current = nextLeft');
    expect(page).toContain('statusBoardHorizontalScrollEdges(viewport, nextLeft)');
    expect(page).toContain('scrollCncBoardHorizontally = useCallback((direction: CncBoardHorizontalScrollDirection) => {');
    expect(page).toContain('if (!scrollEdges[direction]) return;');
    expect(page).toContain("direction === 'left'");
    expect(page).toContain("Math.max(0, viewport.scrollLeft - step)");
    expect(page).toContain("viewport.scrollTo({ left: nextLeft, behavior: 'smooth' })");
    expect(page).not.toContain('if (topScrollbar) topScrollbar.scrollLeft = nextLeft');
    expect(page).toContain('const [cncBoardScrollTopState, setCncBoardScrollTopState] =');
    expect(page).toContain('syncCncBoardScrollTopButton(event.currentTarget)');
    expect(page).toContain("viewport.scrollTo({ top: 0, behavior: 'smooth' })");
    expect(page).toContain('className="cnc-board-scroll-top"');
    expect(page).toContain('style={{ left: cncBoardScrollTopState.left }}');
    expect(page).toContain('Прокрутить МДФ-доску наверх');
    expect(page).toContain('cncBoardScrollEdges.left');
    expect(page).toContain('className="cnc-board-scroll-edge cnc-board-scroll-edge--left"');
    expect(page).toContain('style={{ insetInlineStart: cncBoardScrollButtonInsets.left }}');
    expect(page).toContain("onClick={() => scrollCncBoardHorizontally('left')}");
    expect(page).toContain('cncBoardScrollEdges.right');
    expect(page).toContain('className="cnc-board-scroll-edge cnc-board-scroll-edge--right"');
    expect(page).toContain('style={{ insetInlineEnd: cncBoardScrollButtonInsets.right }}');
    expect(page).toContain("onClick={() => scrollCncBoardHorizontally('right')}");
    expect(page).not.toContain('cncBoardScrollDirection');
    expect(page).toContain('Прокрутить МДФ-доску влево');
    expect(page).toContain('Прокрутить МДФ-доску вправо');
    expect(css).toContain('.cnc-board-scroll-edge.ant-btn');
    expect(css).toContain('inset-block-start: 50dvh');
    expect(css).toMatch(
      /\.cnc-board-scroll-edge--right\.ant-btn\s*\{[^}]*inset-inline-start: auto;[^}]*inset-inline-end: 10px;/,
    );
    expect(css).toMatch(
      /\.cnc-board-scroll-edge--left\.ant-btn\s*\{[^}]*inset-inline-start: 10px;[^}]*inset-inline-end: auto;/,
    );
    expect(css).toContain('background: rgba(17, 24, 39, 0.58)');
    expect(css).toContain('transform: translateY(-50%) scale(0.96)');
    expect(css).toContain('.cnc-board-scroll-top.ant-btn');
    expect(css).toContain('inset-block-end: calc(64px + env(safe-area-inset-bottom, 0px))');
    expect(css).toContain('background: rgba(17, 24, 39, 0.6)');
    expect(css).toContain('transform: translateX(-50%) scale(0.96)');
    expect(css).toMatch(
      /\.status-board-page--cnc \.cnc-detailed-workspace\s*\{[^}]*height: auto;[^}]*overflow: visible;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page\.status-board-page--cnc\s*\{[^}]*height: 100% !important;[^}]*overflow: hidden !important;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-viewport\s*\{[^}]*height: auto;[^}]*overflow-x: auto;[^}]*overflow-y: auto;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.status-board-column__cards\s*\{[^}]*max-height: none;[^}]*overflow-y: visible;/s,
    );
    expect(tabletCss).toMatch(
      /\.status-board-page--cnc \.cnc-today-column--orders \.status-board-column__cards,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_ready \.status-board-column__cards,[\s\S]*?\.status-board-page--cnc \.cnc-today-column--orders_issued \.status-board-column__cards\s*\{[^}]*max-height: var\(--status-board-cnc-order-cards-max-height\);[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/s,
    );
    expect(tabletCss).toContain('.status-board-columns--cnc:not(.status-board-columns--cnc-detailed)');
    expect(tabletCss).toContain('clamp(240px, 24vw, 276px)');
    expect(tabletCss).toMatch(
      /\.status-board-columns--cnc > \.status-board-column\s*\{[^}]*width: auto !important;[^}]*min-width: 0 !important;[^}]*height: auto !important;[^}]*min-height: 100%;/s,
    );
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

  it('keeps order status badge in the order header and overdue as a clock icon', () => {
    expect(page).toContain('status-board-card__identity');
    expect(page).toContain('status-board-card__status-badge');
    expect(page).toContain('status-board-card__overdue-icon');
    expect(page).toContain('aria-label="Плановая дата прошла"');
    expect(page).not.toContain("<Tag color=\"blue\">Авто</Tag>");
    expect(page).not.toContain("<Tag color=\"volcano\">Плановая дата прошла</Tag>");
    expect(css).toContain('.status-board-card__identity');
    expect(css).toContain('.status-board-card__overdue-icon');
    expect(css).toContain('color: #cf1322');
  });

  it('shows the completed-status opt-in only on the production tab with a usable hit area', () => {
    expect(page).toContain("viewState.view === 'production'");
    expect(page).toContain('Показывать завершённые');
    expect(page).toContain('icon={<CheckCircleOutlined />}');
    expect(page).toContain('showDone: !viewState.showDone');
    expect(page).toContain('StatusBoardToolbarIconToggle');
    expect(css).toContain('.status-board-toolbar__icon-toggle.ant-btn');
    expect(css).toContain('height: 32px');
  });

  it('offers persistent server-side card sorting for both status boards', () => {
    expect(page).toContain('Сортировка карточек');
    expect(page).toContain('Сортировать по');
    expect(page).toContain("value: 'orderNumber'");
    expect(page).toContain("value: 'plannedDate'");
    expect(page).toContain("value: 'updatedAt'");
    expect(page).toContain('sortBy: viewState.sortBy');
    expect(page).toContain('sortOrder: viewState.sortOrder');
    expect(page).toContain('window.localStorage');
    expect(page).toContain('status-board-toolbar__sort-settings');
    expect(page).toContain('switchStatusBoardView');
    expect(page).toContain('readStatusBoardSortPreference(currentUser?.id, view)');
    expect(page).toContain('DEFAULT_MDF_ORDER_CARD_SORT');
    expect(page).toContain('Сортировка заказов');
    expect(page).toContain('Свойство сортировки заказов МДФ-доски');
    expect(page).toContain('Направление сортировки заказов МДФ-доски');
    expect(page).toContain('fetchCncOrderStatusBoard(cncOrderIds, {');
    expect(page).toContain('orderStatusBoardApi.consumePrefetchedGet(');
    expect(page).toContain('hasPrefetchedCncOrderStatusBoard(');
    expect(page).toContain('readMdfInitialSnapshot()');
    expect(page).toContain('clearMdfInitialSnapshot(initialMdfSnapshot)');
    expect(page).toContain('CNC_INITIAL_VISIBLE_CARDS_PER_COLUMN = 6');
    expect(page).toContain('CNC_OVERFLOW_CARD_DELAY_MS = 1_200');
    expect(page).toContain('onWheel={revealOverflowCards}');
    expect(page).toContain('export async function prefetchMdfOrderStatusBoard(');
    expect(page).toContain('manualMoves: mapMdfBoardManualMovesResponse(manualMovesResponse.moves)');
    expect(page).toContain('if (preserveInitialSnapshot) {');
    expect(page).toContain('preserveInitialMdfOrderBoardRef.current = false');
    expect(page).toContain('if (!preserveInitialManualMoves) void loadManualMoves()');
    expect(page).toContain('orderSort={cncOrderSortPreference}');
    expect(page).toContain('compareCncOrderBoardCards');
  });

  it('keeps CNC work as a separate visual flow and API contract', () => {
    expect(page).toContain('cncTelegram: featureFlags.cncTelegram');
    expect(page).toContain('fixedView ? { fixedView } : {}');
    expect(page).toContain('defaultCncOrderSearchPeriod?: CncOrderSearchPeriod;');
    expect(page).toContain('defaultCncOrderSearchPeriod = DEFAULT_CNC_ORDER_SEARCH_PERIOD');
    expect(page).toContain('defaultCncOrderSearchPeriod,');
    expect(page).toContain('<OrderStatusBoardPage active={active} fixedView="cnc_today" defaultCncOrderSearchPeriod="1m" />');
    expect(page).toContain("{isCncToday ? 'МДФ-работы' : 'Доски статусов'}");
    expect(page).toContain('{!fixedView && (');
    expect(page).not.toContain("{ key: 'cnc_today', label: 'МДФ-работы' }");
    expect(app).toContain('name: "mdf-work-board"');
    expect(app).toContain('list: "/mdf-work-board"');
    expect(app).toContain('<Route path="/mdf-work-board">');
    expect(page).toContain('cncTelegramApi.consumePrefetchedToday');
    expect(page).not.toContain('workday ? { date: workday } : {}');
    expect(page).toContain('<CncTelegramTodayColumns');
    expect(page).toContain("parsed: 'Файлы на станке'");
    expect(page).toContain('CncTelegramBathCardView');
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).toContain('CNC_HISTORY_DAYS = 7');
    expect(page).toContain('aria-label="Дата CNC-работ"');
    expect(page).toContain('buildCncOrderFilterOptions');
    expect(page).toContain('filterCncTodayColumnsByOrders');
    expect(page).toContain('filterCncTodayColumnsByPlannedOrderDate');
    expect(page).toContain('filterCncOrderCardsByPlannedOrderDate');
    expect(page).toContain('filterCncBathColumnsByMachineOrderMatches');
    expect(page).toContain('status-board-toolbar__cnc-order-search');
    expect(page).toContain('mode="multiple"');
    expect(page).toContain('suffixIcon={<SearchOutlined />}');
    expect(page).toContain('options={cncOrderFilterOptions}');
    expect(page).toContain('aria-label="Фильтр МДФ-работ по номеру заказа"');
    expect(page).toContain('filterCncTodayColumnsByOrders(cncPeriodColumns, cncOrderFilters)');
    expect(page).toContain('viewState.cncPlannedTodayOnly');
    expect(page).toContain('cncPlannedTodayDate');
    expect(page).not.toContain('filterCncBazisCutSetsByMissingBathDetails');
    expect(page).toContain('status-board-toolbar__cnc-period');
    expect(page).not.toContain('<Typography.Text type="secondary">Период</Typography.Text>');
    expect(page).toContain('DEFAULT_CNC_ORDER_SEARCH_PERIOD');
    expect(page).toContain("label: '1 день', value: '1d'");
    expect(page).toContain("label: '1нед'");
    expect(page).toContain("label: '2нед'");
    expect(page).toContain("label: '1м'");
    expect(page).toContain('aria-pressed={active}');
    expect(page).toContain("if (period === '1d')");
    expect(page).toContain("cncWorkday: dayjs().format('YYYY-MM-DD')");
    expect(page).toContain('onClick={() => updateCncDisplayPeriod(option.value)}');
    expect(page).toContain('buildCncOrderSearchDateRange');
    expect(page).toContain('dateFrom: displayRange.dateFrom');
    expect(page).toContain('dateTo: displayRange.dateTo');
    expect(page).toContain('buildOrderStatusBoardDatasetKey(');
    expect(model).toContain('export function buildOrderStatusBoardDatasetKey(');
    expect(model).toContain("state.view === 'cnc_today'");
    expect(model).toContain("key.set('date', state.cncWorkday ?? defaultCncWorkday)");
    expect(model).toContain("key.set('period', state.cncOrderSearchPeriod ?? defaultCncOrderSearchPeriod)");
    expect(page).not.toContain("if (params.get('flow') === 'cnc') params.delete('order');");
    expect(page).toContain('const standardGridMinWidth = displayColumns.length * 220');
    expect(page).toContain('gridTemplateColumns: `repeat(${displayColumns.length}, minmax(${cncColumnMinWidth}, 1fr))`');
    expect(page).toContain('buildCncColumnTotals(column, relationContext, detailedContext)');
    expect(page).toContain('CncBazisCutSetCardView');
    expect(page).toContain('Итоги по ERP-заказам набора');
    expect(page).toContain('aria-label={`Открыть Базис-раскрой БР-${card.bazisCutSetId}`}');
    expect(page).toContain('getCncBazisCutSetDisplayState(card, relationContext, detailedContext)');
    expect(page).toContain('buildCncBazisCutSetFingerprint');
    expect(css).toContain('.cnc-bazis-cut-card');
    expect(page).not.toContain('buildCncDetailedDisplayColumns(columns)');
    expect(page).toContain("getCncBathRelationState(bath, relationContext) !== 'dimmed'");
    expect(page).toContain("getCncPacketDisplayState(packet, relationContext, detailedContext) !== 'dimmed'");
    expect(page).toContain('cnc-today-column__header-main');
    expect(page).toContain('cnc-today-column__totals');
    expect(page).toContain('cnc-today-column__totals-placeholder');
    expect(page).toContain('CncColumnCardPlaceholders');
    expect(page).toContain('<Skeleton.Input');
    expect(page).toContain('loading={cncColumnsLoading}');
    expect(page).toContain('loading && !isCncToday && !board');
    expect(page).toContain('columns={cncRenderColumns}');
    expect(page).toContain("{totals.details} дет. · {formatArea(totals.areaM2)}");
    expect(page).toContain('По выбранному заказу МДФ-работ нет');
    expect(page).toContain('В чате {formatDateTime');
    expect(page).toContain('<Collapse.Panel');
    expect(page).toContain('<details');
    expect(page).toContain('className="cnc-order-card__missing-summary"');
    expect(page).toContain('formatCncMissingDetailsSummary(details)');
    expect(page).toContain('Отсутствуют - позиций - ${positionCount}, деталей - ${detailCount}');
    expect(page).toContain('onToggle={(event) => setOpen(event.currentTarget.open)}');
    expect(page).toContain('{open && (');
    expect(page).toContain('canDrag: () => moveAvailable && finePointer && !dragSuppressedRef.current');
    expect(page).toContain('data-cnc-manual-drag-ignore="true"');
    expect(page).toContain('onPointerDown={stopCncCardNestedInteraction}');
    expect(css).toContain('grid-column: 1 / -1');
    expect(css).toContain('width: 100%');
    expect(css).toMatch(/\.cnc-order-card__missing-label\s*\{[^}]*font-weight: 400;/);
    expect(css).toContain('.cnc-order-card__missing-summary::after');
    expect(css).toContain('.cnc-order-card__missing[open] .cnc-order-card__missing-summary::after');
    expect(page).toContain('cncColumnDisplayTitle(column)');
    expect(page).toContain("baths: 'Карты ванн'");
    expect(page).toContain("baths_ready: 'Готовы к закатке'");
    expect(page).not.toContain('Строка не сопоставлена с ERP');
    expect(page).not.toContain('items={[{');
    expect(page).not.toContain("board: 'cnc");
  });

  it('keeps the Basis-cut card compact and expands its full detail list', () => {
    const cardStart = page.indexOf('const CncBazisCutSetCardView =');
    const cardEnd = page.indexOf('interface CncTelegramPacketCardProps', cardStart);
    const card = page.slice(cardStart, cardEnd);

    expect(card).toContain('const [detailsOpen, setDetailsOpen] = useState(false)');
    expect(card).toContain('className="cnc-bazis-cut-card__badge"');
    expect(card).toContain('onClick={openSet}');
    expect(card).not.toContain('cnc-bazis-cut-card__set-link');
    expect(card).not.toContain('cnc-bazis-cut-card__open');
    expect(card).not.toContain('card.positionCount');
    expect(card).toContain('aria-label="Данные Базис-раскроя"');
    expect(card).toContain('aria-label="Детали Базис-раскроя"');
    expect(card).toContain('setDetailsOpen((current) => !current)');
    expect(card).toContain('card.items.map((item, index)');
    expect(card).toContain('<span>Создан</span>');
    expect(card).toContain('<span>{formatGmtPlus5Date(card.createdAt)}</span>');
    expect(card).toContain('className="status-board-card__footer"');
    expect(page).toContain('const GMT_PLUS_5_OFFSET_MS = 5 * 60 * 60 * 1000');
    expect(page).toContain("function formatGmtPlus5Date(value: string | null | undefined): string");
    expect(page).toContain('date.getUTCDate()');
    expect(page).toContain('date.getUTCMonth() + 1');
    expect(css).toMatch(
      /\.cnc-bazis-cut-card__tabs\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
    );
  });

  it('keeps bath cards printable with SVG and PDF previews', () => {
    expect(page).toContain('fetchCncMdfBoardSheetSvg');
    expect(page).not.toContain('cutApi.fetchSheetSvg(');
    expect(mdfSheetPreview).toContain('cutApi.fetchSheetSvg(');
    expect(mdfSheetPreview).toContain('CUT_RENDER_STYLE_MDF_BOARD_PREVIEW');
    expect(page).toContain('cutApi.fetchJobPdf');
    expect(page).toContain('CutSheetLabelGenerateAction');
    expect(page).toContain('svgCutSheet && svgCutSheet.detailIds.length > 0');
    expect(page).toContain('buildLabelDetailsFromRepeatedDetailIds(svgCutSheet.detailIds, packet.items)');
    expect(page).toContain('buildLabelDetailsFromPacketItems(packet.items)');
    expect(page).toContain('detailInstances={labelDetailInstances}');
    expect(page).not.toContain('detailIds={labelSheet.detailIds}');
    expect(page).toContain('labelCoverage={labelCoverage}');
    expect(page).toContain('labelCoverage: CutSheetLabelCoverage | null;');
    expect(page).toContain('item.matchDetailQuantity');
    expect(page).toContain('instance <= availableQuantity');
    expect(page).toContain('В ERP у детали количество');
    expect(page).toContain('cutMapFallbackImageFromPacket(packet)');
    expect(page).toContain('ImagePrintPreviewModal');
    expect(page).toContain('aria-label={`Печать скрина листа ${title}`}');
    expect(page).toContain('const fetchFreshPdf = useCallback');
    expect(page).toContain('const downloadPdf = useCallback(async () =>');
    expect(page).toContain('const printPdf = useCallback(async () =>');
    expect(page).toContain('<span>Раскрой</span>');
    expect(page).toContain('<span>{formatGmtPlus5Date(bath.createdAt)}</span>');
    expect(page).not.toContain('formatDateTime(bath.createdAt)');
    expect(page).toContain('triggerBlobDownload(result.blob');
    expect(page).toContain('const freshUrl = URL.createObjectURL(result.blob)');
    expect(page).toContain("CNC_BATH_DEFAULT_PDF_TEMPLATE = 'bath_profiles'");
    expect(page).toContain('Шаблон PDF ванны');
    expect(page).not.toContain("import('pdfjs-dist')");
    expect(pdfPreview).toContain("import('pdfjs-dist')");
    expect(page).toContain('renderCncPdfPagePreviews(result.blob)');
    expect(page).toContain('data-testid="cnc-bath-pdf-preview-pages"');
    expect(page).not.toContain('<iframe');
    expect(page).not.toContain('triggerBlobDownload(blob, fileName');
    expect(page).not.toContain("window.open(url, '_blank')");
    expect(page).toContain('PrinterOutlined');
    expect(page).toContain('TagsOutlined');
    expect(page).toContain('DownloadOutlined');
    expect(css).toContain('.cnc-packet-card__sheet-actions');
    expect(css).toContain('flex-wrap: nowrap');
    expect(css).toContain('.cnc-bath-card__pdf-pages');
    expect(css).toContain('.cnc-bath-card__pdf-page-image');
    expect(css).not.toContain('.cnc-bath-card__ready-icon');
  });

  it('does not duplicate the completed CNC file state with a check marker', () => {
    const cardStart = page.indexOf('const CncTelegramPacketCard =');
    const cardEnd = page.indexOf('interface CncPacketSheetPreviewModalProps', cardStart);
    const packetCard = page.slice(cardStart, cardEnd);

    expect(packetCard).not.toContain("packet.completionStatus === 'completed'");
    expect(packetCard).not.toContain('<CheckCircleOutlined />');
    expect(packetCard).not.toContain('Распилено на станке');
    expect(css).not.toContain('.cnc-packet-card__status-icon--completed');
  });

  it('does not duplicate bath readiness with a check marker', () => {
    const cardStart = page.indexOf('const CncTelegramBathCardView =');
    const cardEnd = page.indexOf('function buildCncOrderSummaries', cardStart);
    const bathCard = page.slice(cardStart, cardEnd);

    expect(page).not.toContain('showReadyIcon');
    expect(page).not.toContain('<CheckCircleFilled');
    expect(bathCard).not.toContain('cnc-bath-card__ready-icon');
    expect(css).not.toContain('.cnc-bath-card__ready-icon');
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
    expect(page).not.toContain('summary.positions');
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
    expect(page).toContain('isCncReworkComment(comment)');
    expect(css).toMatch(/\.cnc-packet-card__note-rework\s*\{[^}]*color: #cf1322;[^}]*font-weight: 700;/);
    expect(css).toMatch(/\.cnc-packet-card__note-rework\.ant-typography\s*\{[^}]*color: #cf1322;/);
    const cncFileNameRules = css.match(/\.cnc-packet-card__note-file\s*\{[^}]*\}/g) ?? [];
    expect(cncFileNameRules.length).toBeGreaterThan(0);
    expect(cncFileNameRules.every((rule) => rule.includes('color: var(--app-text-muted);'))).toBe(true);
  });

  it('offers compact MDF cards with per-card temporary standard view', () => {
    const mobileCncContainerStart = css.indexOf('@container status-board-viewport (max-width: 960px)');
    const mobileCncContainerEnd = css.indexOf('@media (max-width: 768px)', mobileCncContainerStart);
    const mobileCncContainer = css.slice(mobileCncContainerStart, mobileCncContainerEnd);

    expect(page).toContain('type CncCardDisplayMode,');
    expect(page).toContain('const [cncCardDisplayMode, setCncCardDisplayMode]');
    expect(page).toContain('aria-label="Формат карточек МДФ-доски"');
    expect(page).toContain("label: 'Стандартный'");
    expect(page).toContain("label: 'Средний'");
    expect(page).toContain("label: 'Компактный'");
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
    expect(page).toContain("data-cnc-card-view={minimal ? 'minimal' : summaryOnly ? 'compact' : 'standard'}");
    expect(page).toContain('event.stopPropagation()');
    expect(css).toContain('.cnc-card-display-toggle.ant-btn');
    expect(css).toContain('min-width: 40px');
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('.cnc-card-display-toggle__icon');
    expect(css).toContain('scale(0.25)');
    expect(css).toContain('blur(4px)');
    expect(css).toContain('cubic-bezier(0.2, 0, 0, 1)');
    expect(css).not.toContain('transition: all');
    expect(mobileCncContainer).toContain(
      '.status-board-columns--cnc:not(.status-board-columns--cnc-standard) .status-board-card__standard-grid',
    );
    expect(mobileCncContainer).toContain(
      '.status-board-columns--cnc:not(.status-board-columns--cnc-standard) .cnc-packet-card__sheet',
    );
    expect(mobileCncContainer).not.toContain(
      '.status-board-columns--cnc .status-board-card__standard-grid',
    );
    expect(mobileCncContainer).not.toContain(
      '.status-board-columns--cnc .cnc-packet-card__sheet',
    );
    expect(mobileCncContainer).not.toContain(
      '.status-board-columns--cnc .status-board-card__top',
    );
  });

  it('adds a number-only compact MDF card mode', () => {
    const packetCardStart = page.indexOf('const CncTelegramPacketCard =');
    const packetMinimalStart = page.indexOf('if (minimal) {', packetCardStart);
    const packetMinimalEnd = page.indexOf('\n\n  return (', packetMinimalStart);
    const packetMinimal = page.slice(packetMinimalStart, packetMinimalEnd);
    const bathCardStart = page.indexOf('const CncTelegramBathCardView =');
    const bathMinimalStart = page.indexOf('{minimal ? (', bathCardStart);
    const bathMinimalEnd = page.indexOf(') : (', bathMinimalStart);
    const bathMinimal = page.slice(bathMinimalStart, bathMinimalEnd);

    expect(model).toContain("export type CncCardDisplayMode = 'standard' | 'compact' | 'minimal' | 'screenshot'");
    expect(page).toContain("cardDisplayMode === 'minimal' ? 'status-board-columns--cnc-minimal' : ''");
    expect(page).toContain("const cncColumnMinWidth = cardDisplayMode === 'minimal'");
    expect(page).toContain("'var(--status-board-cnc-column-width, 132px)'");
    expect(page).toContain("'var(--status-board-cnc-column-width, 220px)'");
    expect(page).toContain("displayMode={cardDisplayMode === 'minimal' ? 'minimal' : 'standard'}");
    expect(page).toContain('const compactCutNumber = formatCncPacketCompactNumber(packet);');
    expect(page).toContain('const displayCutJobNumber = cncPacketDisplayCutJobNumber(packet);');
    expect(packetMinimal).toContain('href={cutJobPath}');
    expect(packetMinimal).toContain('cnc-compact-card__number cnc-compact-card__number--link');
    expect(page).toContain('const cutJobPath = cncPacketCutJobPath(packet);');
    expect(page).toContain('function cncPacketCutJobPath(packet: CncTelegramPacket): string | null');
    expect(page).toContain('return packet.svgCutJobId != null');
    expect(page).toContain('function cncPacketDisplayCutJobNumber(packet: CncTelegramPacket): string | null');
    expect(page).toContain('const svgDisplayNumber = packet.svgCutJobDisplayNumber?.trim();');
    expect(page).toContain("return cncPacketDisplayCutJobNumber(packet) ?? '—';");
    expect(page).not.toContain('formatCncPacketBasisCutNumber');
    expect(page).not.toContain('packet.svgCutSheets ?? []');
    expect(packetMinimal).not.toContain('<span className="cnc-compact-card__ref-label">Раскрой</span>');
    expect(packetMinimal).not.toContain('<span className="cnc-compact-card__ref-label">Базис</span>');
    expect(packetMinimal).not.toContain('Базис');
    expect(bathMinimal).toContain('{bathCutNumber}');
    expect(bathMinimal).not.toContain('№');
    expect(page).toContain("minimal ? 'cnc-bath-card--minimal cnc-compact-card' : ''");
    expect(page).toContain("minimal ? 'cnc-bazis-cut-card--minimal cnc-compact-card' : ''");
    expect(page).toContain("cncNumberOnly ? 'cnc-order-card--minimal cnc-compact-card' : ''");
    expect(page).toContain('!cncNumberOnly && (');
    expect(css).toContain('.status-board-columns--cnc-minimal .status-board-column__cards');
    expect(css).toContain('.cnc-compact-card');
    expect(css).toContain('.cnc-compact-card__number');
    expect(css).toContain('.cnc-compact-card__number--link');
    expect(css).toMatch(
      /\.cnc-bath-card--minimal \.cnc-compact-card__number\s*\{[^}]*font-size: 9\.8px;/s,
    );
    expect(css).not.toContain('.cnc-compact-card__refs');
  });

  it('opens MDF machine-file sheet previews as a user-scoped display mode', () => {
    const packetCardStart = page.indexOf('const CncTelegramPacketCard =');
    const packetCardEnd = page.indexOf('CncTelegramPacketCard.displayName', packetCardStart);
    const packetCard = page.slice(packetCardStart, packetCardEnd);

    expect(page).toContain("{ label: 'Скрин', value: 'screenshot' }");
    expect(page).toContain('screenshot: <PictureOutlined />');
    expect(page).toContain("const CNC_CARD_DISPLAY_STORAGE_PREFIX = 'erp.status-board.cnc-card-display'");
    expect(page).toContain('useState<CncCardDisplayMode>(() => readCncCardDisplayPreference(currentUser?.id))');
    expect(page).toContain('writeCncCardDisplayPreference(currentUser?.id, mode)');
    expect(page).toContain("value === 'screenshot'");
    expect(page).toContain('cncUsesStandardColumnLayout(cardDisplayMode)');
    expect(page).toContain("cardDisplayMode === 'screenshot' ? 'status-board-columns--cnc-screenshot' : ''");
    expect(packetCard).toContain("displayMode === 'screenshot' && hasSheetPreview");
    expect(packetCard).toContain("setActiveAuxView('sheet')");
    expect(packetCard).toContain("if (displayMode !== 'screenshot')");
    expect(packetCard).toContain("current === 'sheet' ? null : current");
    expect(packetCard).toContain("data-cnc-card-view={displayMode === 'screenshot' ? 'screenshot' : summaryOnly ? 'compact' : 'standard'}");
  });

  it('shows detail totals without position counts on every MDF card', () => {
    const summaryLineStart = page.indexOf('const CncOrderSummaryLine:');
    const summaryLineEnd = page.indexOf('interface CncTelegramPrintBoardProps', summaryLineStart);
    const summaryLine = page.slice(summaryLineStart, summaryLineEnd);
    const packetCardStart = page.indexOf('const CncTelegramPacketCard =');
    const packetCardEnd = page.indexOf('const CncTelegramBathCardView =', packetCardStart);
    const packetCard = page.slice(packetCardStart, packetCardEnd);
    const bathCardStart = packetCardEnd;
    const bathCardEnd = page.indexOf('interface CncBathPdfPreviewProps', bathCardStart);
    const bathCard = page.slice(bathCardStart, bathCardEnd);
    const compactMetaRule = css.match(
      /\.cnc-card--summary-only \.cnc-packet-card__summary-meta\s*\{[^}]*\}/s,
    )?.[0] ?? '';

    expect(page).toContain("const CNC_ORDER_DETAILS_SEPARATOR = '\\u00A0\\u00A0-\\u00A0\\u00A0'");
    expect(summaryLine).toContain('className="cnc-order-details-separator"');
    expect(summaryLine).toContain('{CNC_ORDER_DETAILS_SEPARATOR}');
    expect(summaryLine).toContain('{summary.details} дет.');
    expect(summaryLine).not.toContain('summary.positions');
    expect(packetCard).toContain('{packet.itemQuantityTotal} деталей');
    expect(packetCard).not.toContain('packet.itemCount');
    expect(bathCard).toContain('{bath.itemQuantityTotal} деталей');
    expect(bathCard).not.toContain('bath.positionCount');
    expect(page).not.toContain('positions: number;');
    expect(page).toContain('{summary.details} дет.');
    expect(page).toContain('className="cnc-order-card__compact-client"');
    expect(css).toMatch(
      /\.cnc-card--summary-only \.cnc-packet-card__summary-order[^}]*\{[^}]*font-size: 1\.2em;[^}]*color: var\(--app-text\);/s,
    );
    expect(compactMetaRule).toContain('color: var(--app-text-muted);');
    expect(compactMetaRule).not.toContain('margin-inline-start');
    expect(css).toMatch(
      /\.cnc-order-card--summary-only \.status-board-card__number[^}]*\{[^}]*font-size: 1\.2em;[^}]*color: var\(--app-text\);/s,
    );
  });

  it('shows the bath cut-job number without a readiness check and removes terminal work', () => {
    const actionsStart = page.indexOf('<div className="cnc-bath-card__actions">');
    const actionsEnd = page.indexOf('</div>', actionsStart);
    const actions = page.slice(actionsStart, actionsEnd);
    expect(page).toContain('function formatCncBathCardCutNumber(');
    expect(page).toContain('const displayCutNumber = bath.displayCutNumber?.trim();');
    expect(page).toContain('if (displayCutNumber) return displayCutNumber;');
    expect(page).toContain('return `В-${bath.cutJobId}`;');
    expect(page).toContain('const bathCutNumber = formatCncBathCardCutNumber(bath);');
    expect(actions).toContain('className="cnc-bath-card__cut-result-badge"');
    expect(actions).toMatch(/>\s*\{bathCutNumber\}\s*<\/Tag>/);
    expect(actions).not.toContain('№{bath.cutNumber}');
    expect(page).toContain('aria-label={`Номер карты раскроя ${bathCutNumber}`}');
    expect(page).toMatch(/className="cnc-compact-card__number"[\s\S]*\{bathCutNumber\}/);
    expect(page).not.toContain('aria-label={`Номер ванны ${bath.cutNumber}`}');
    expect(actions).not.toContain('cnc-bath-card__ready-icon');
    expect(css).toMatch(
      /\.cnc-bath-card__actions\s*\{[^}]*align-items: center;/s,
    );
    expect(css).toMatch(
      /\.cnc-bath-card__cut-result-badge\.ant-tag\s*\{[^}]*padding-inline: 6px;[^}]*border-radius: 4px;[^}]*font-size: 0\.84em;[^}]*font-variant-numeric: tabular-nums;/s,
    );
    expect(page).toContain('applyMdfBoardHiddenCardRulesToColumns(');
    expect(page).toContain('SETTING_KEYS.STATUS_AUTOMATION_MDF_BOARD_HIDDEN_PRODUCTION_STATUSES');
    expect(page).toContain('resolveMdfBoardHiddenOrderStatusIds(');
    expect(page).toContain('resolveMdfBoardHiddenProductionStatusIds(');
    expect(page).toContain('cncHiddenOrderStatusIds');
    expect(page).toContain('cncHiddenProductionStatusIds');
    expect(page).toContain('cncDisplayOrderStatusCards.filter((card) => !cncMutedOrderIds.has(card.orderId))');
  });

  it('forces MDF refresh to reload all freshness inputs without browser cache', () => {
    expect(page).toContain('refetch: refetchAppSettings');
    expect(page).toContain('const cncStrongRefreshInFlightRef = useRef(false)');
    expect(page).toContain('const cncAuxiliaryRefreshRevisionRef = useRef(0)');
    expect(page).toContain('const auxiliaryRevision = ++cncAuxiliaryRefreshRevisionRef.current');
    expect(page).toContain("cncTelegramApi.consumePrefetchedToday({");
    expect(page).toContain("}, { cache: 'no-store' })");
    expect(page).toContain("fetchCncManualMoves({ cache: 'no-store' })");
    expect(page).toContain('refetchMdfBoardSettings()');
    expect(page).toContain('const refreshedOrderIds = collectCncOrderStatusBoardIds(');
    expect(page).toContain('fetchCncOrderStatusBoard(\n              refreshedOrderIds,');
    expect(page).toContain("}, { cache: 'no-store' });");
    expect(page).toContain('cncAuxiliaryRefreshRevisionRef.current !== auxiliaryRevision');
    expect(page).toContain('cncStrongRefreshInFlightRef.current = false');
    expect(page).toContain('cncAuxiliaryRefreshRevisionRef.current === requestRevision');
  });

  it('prevents failed manual-move recovery from overwriting a strong MDF refresh', () => {
    const fallbackStart = page.indexOf(
      'const refreshSupersededMove =',
    );
    const fallbackEnd = page.indexOf(
      "message.error(errorMessage(error, 'Не удалось сохранить ручное перемещение МДФ-доски.'))",
      fallbackStart,
    );
    const fallback = page.slice(fallbackStart, fallbackEnd);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(page).toContain(
      'const moveRefreshRevision = cncAuxiliaryRefreshRevisionRef.current',
    );
    expect(fallback).toContain('if (!refreshSupersededMove)');
    expect(fallback).toContain('setCncManualMoves((current) =>');
    expect(fallback).toContain("fetchCncManualMoves({ cache: 'no-store' })");
    expect(fallback).toContain('cncStrongRefreshInFlightRef.current');
    expect(fallback).toContain(
      'cncAuxiliaryRefreshRevisionRef.current !== moveRefreshRevision',
    );
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
    expect(css).toContain(
      '.status-board-columns--cnc:not(.status-board-columns--cnc-standard) .cnc-packet-card__summary-meta',
    );
    expect(css).toContain(
      '.status-board-columns--cnc:not(.status-board-columns--cnc-standard) .status-board-card__standard-grid',
    );
    expect(css).toContain(
      '.status-board-columns--cnc:not(.status-board-columns--cnc-standard) .cnc-order-card__compact-client',
    );
  });

  it('prints the compact MDF board in landscape with repeated column headers', () => {
    const printCardStart = page.indexOf('const CncTelegramPrintCard');
    const printCardEnd = page.indexOf('interface CncCardDisplayToggleProps', printCardStart);
    const printCard = page.slice(printCardStart, printCardEnd);
    const toolbarPrintButtonStart = page.indexOf('className="status-board-toolbar__cnc-print"');
    const toolbarPrintButtonEnd = page.indexOf('</Tooltip>', toolbarPrintButtonStart);
    const toolbarPrintButton = page.slice(toolbarPrintButtonStart, toolbarPrintButtonEnd);

    expect(page).toContain("import { createPortal } from 'react-dom';");
    expect(page).toContain("cncCardDisplayMode !== 'standard'");
    expect(page).toContain('aria-label="Распечатать компактную МДФ-доску"');
    expect(page).toContain('onClick={() => window.print()}');
    expect(toolbarPrintButton).toContain('icon={<PrinterOutlined />}');
    expect(toolbarPrintButton).not.toContain('>Печать');
    expect(page).toContain("cardDisplayMode !== 'standard' && createPortal(");
    expect(page).toContain('<CncTelegramPrintBoard');
    expect(page).toContain('displayMode={cardDisplayMode}');
    expect(page).toContain('displayMode: CncCardDisplayMode;');
    expect(page).toContain("className={`cnc-print-board cnc-print-board--${displayMode}`}");
    expect(page).toContain('const cards: CncPrintCard[] = isCncOrderColumnKey(column.key)');
    expect(page).toContain("kind: 'order' as const");
    expect(page).toContain('order: entry.card');
    expect(printCard).toContain("if (displayMode === 'minimal') {");
    expect(printCard).toContain('cnc-print-card--minimal');
    expect(printCard).toContain('cnc-print-card__minimal-number');
    expect(printCard).toContain('formatCncPacketCompactNumber(card.packet)');
    expect(printCard).toContain('formatStatusBoardOrderNumber(card.order)');
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
    expect(css).toContain('.cnc-print-board--minimal .cnc-print-card');
    expect(css).toContain('.cnc-print-card__minimal-number');
    expect(css).toMatch(/\.cnc-print-card__sequence\s*\{[^}]*color: #000;/);
    expect(css).toMatch(/\.cnc-print-card__sequence-sign\s*\{[^}]*font-size: 0\.5em;/);
    expect(css).toContain('display: table-header-group');
    expect(css).toContain('break-inside: avoid');
    expect(printCard).toContain('className="cnc-print-card__bath-cut-number"');
    expect(printCard).toContain('className="cnc-order-details-separator"');
    expect(printCard).toContain('{CNC_ORDER_DETAILS_SEPARATOR}');
    expect(printCard).toContain('formatCncBathCardCutNumber(card.bath)');
    expect(printCard).toContain('{bathCutNumber}');
    expect(printCard).not.toContain('№{card.bath.cutNumber}');
    expect(css).toMatch(
      /\.cnc-print-card__bath-cut-number\s*\{[^}]*border-radius: 1mm;[^}]*font-variant-numeric: tabular-nums;/s,
    );
    expect(css).toMatch(
      /\.cnc-print-card__summary\s*\{[^}]*justify-content: flex-start;[^}]*gap: 0;/s,
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
    expect(page).toContain('? buildCncRelationContext(cncShownDataColumns, cncOrderCards, activeCncRelation)');
    expect(page).toContain("key: 'orders' as const");
    expect(page).toContain("orders: 'Заказы'");
    expect(page).toContain('orderStatusBoardApi.consumePrefetchedGet(');
    expect(page).toContain('cncOrderStatusBoardQuery(chunk, sortPreference)');
    expect(page).toContain('CNC_ORDER_STATUS_REFRESH_MS');
    expect(page).toContain('const alreadyLoaded = cncOrderBoardRequestKeyRef.current === requestKey;');
    expect(page).toContain('if (!alreadyLoaded) void loadOrderBoard();');
    expect(page).toContain('const timer = window.setInterval(() => {');
    expect(page).toContain('}, CNC_ORDER_STATUS_REFRESH_MS);');
    expect(page).toContain("primaryStatusKind === 'order' || board === 'order'");
    expect(page).toContain("card.orderStatusName || 'Без статуса'");
    expect(page).not.toContain('statusBadgeOverride={');
    expect(page).toContain('getCncOrderRelationState');
    expect(page).toContain("onSelectRelation({ kind: 'order', id: card.orderId })");
    expect(page).toContain('openOrderOnNumber={!relationsEnabled}');
    expect(page).toContain('const orderNumberOpensOrder = openOrderOnNumber || cncOrderCard');
    expect(page).toContain('if (!orderNumberOpensOrder) return;');
    expect(page).toContain('activeOrderKeys: ReadonlySet<string> | null;');
    expect(page).toContain('activeOrderKeys: fingerprint.orderKeys,');
    expect(page).toContain('const highlightedOrderKeys = relationContext?.activeOrderKeys ?? null;');
    expect(page).toContain('highlightedOrderKeys={highlightedOrderKeys}');
    expect(page).toContain('highlightedOrderKeys.has(orderKey)');
    expect(page).toContain('cncRelationOrderKeys(');
    expect(page).toContain('cnc-order-number--highlighted');
    expect(page).toContain('const allBathCards = relationContext');
    expect(page).toContain('const allMachineFileCards = buildCncMachineColumnCards(');
    expect(page).toContain('machineFileCards.map((entry) =>');
    expect(page).toContain("kind: 'bazisCutSet',");
    expect(page).toContain('id: bazisCutSet.bazisCutSetId');
    expect(page).toContain("active.kind === 'bazisCutSet'");
    expect(page).toContain('export function cncRelationStatePriority');
    expect(page).toContain('sortCncRelationCards');
    expect(page).toContain('getCncPacketRelationState');
    expect(page).toContain('getCncBathRelationState');
    expect(page).toContain("'order-mentioned'");
    expect(detailedMachine).toContain('CNC_OTHER_MATERIAL_MARKER_PATTERN');
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
    expect(css).toContain('.cnc-order-number--highlighted');
    expect(css).toContain('background: #ffeb00');
    expect(css).toContain('.cnc-today-column--parsed');
    expect(css).toContain('.cnc-today-column--completed');
    expect(css).toContain('background: #edf7ff');
    expect(css).toContain('.cnc-today-column--baths');
    expect(css).toContain('.cnc-today-column--baths_ready');
    expect(css).toContain('.cnc-today-column--baths_laminated');
    expect(page).toContain("completed_baths: 'Завершенные ванны'");
    expect(css).toContain('.cnc-today-column--orders_ready');
    expect(css).toContain('.cnc-today-column--orders_issued');
    expect(page).toContain("title: 'Готов к выдаче'");
    expect(page).toContain("title: 'Выдан'");
    expect(page).toContain('Распилено {cncReadiness.cutDetails}');
    expect(page).toContain('if (packet.rework) continue;');
    expect(page).toContain('if (!cncPacketCountsForMdfReadiness(packet)) continue;');
    expect(page).toContain('if (!cncMaterialNameIsMdf(item.materialName)) continue;');
    expect(page).toContain('Закатано {cncReadiness.rolledDetails}');
    expect(page).toContain('Осталось {cncReadiness.remainingDetails}');
    expect(page).toContain('className="cnc-order-card__client"');
    expect(page).toContain("cncOrderCard ? 'cnc-order-card__parts-total' : ''");
    expect(page).toContain('paymentSummary && !cncOrderCard');
    expect(css).toMatch(/\.cnc-order-card__readiness\s*\{[^}]*display: grid;/s);
    expect(css).toContain('.cnc-order-card__client');
    expect(css).toContain('justify-content: flex-start;');
    expect(css).toContain('gap: 6px;');
    expect(css).toContain('font-size: clamp(14px, 4.8cqw, 16px)');
    expect(css).toContain('font-size: clamp(11px, 3.8cqw, 12.5px)');
    expect(css).toMatch(/\.cnc-order-card__parts-total\s*\{[^}]*white-space: nowrap;/s);
    expect(css).toContain('.cnc-order-card__progress-segment--cut');
    expect(css).toContain('.cnc-order-card__progress-segment--rolled');
    expect(css).toContain('background: #fff7e6');
    expect(css).toContain('.status-board-columns--cnc > .status-board-column');
    expect(css).toContain(
      'grid-template-columns: repeat(var(--status-board-cnc-column-count, 5), minmax(0, 1fr))',
    );
    expect(css).toContain('.cnc-today-column__header-main');
    expect(css).toContain('.cnc-today-column__totals');
    expect(css).toContain('.cnc-today-column__badge-placeholder');
    expect(css).toContain('.cnc-column-placeholder-card');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    expect(css).toContain('border-color: #722ed1');
    expect(css).toContain('0 0 0 2px #722ed1');
    expect(css).not.toContain('transition: all');
  });

  it('hydrates only near-viewport MDF cards in standard mode', () => {
    expect(page).toContain("displayMode !== 'standard'");
    expect(page).toContain("{ rootMargin: '240px 80px' }");
    expect(page).not.toContain('}, 1_500);');
    expect(page).toContain('const cleanup = observeDeferredCncCard(element, () => setRevealed(true));');
    expect(page).toContain('fallbackLabel={card.orderName || String(card.orderId)}');
    expect(page).toContain('onPointerEnter={() => setRevealed(true)}');
    expect(page).toContain('previous.contentIdentity === next.contentIdentity');
    expect(page).toContain('previous.renderDependencies.every(');
    expect(page).toContain('<CncDeferredCard');
    expect(page).toContain('focusedCardKind={viewState.cncCardKind}');
    expect(page).toContain('focusedCardId={viewState.cncCardId}');
    expect(page).toContain('setCncOrderBoardLoading(true);');
    expect(page).toContain('startTransition(() => setCncOrderBoard(orderBoardResponse));');
    expect(css).toContain('.cnc-deferred-card--revealed');
  });

  it('refreshes expired MDF prefetch data when the operator navigates to the board', () => {
    expect(siderMenuItems).toContain("MDF_BOARD_PREFETCH_EVENT = 'erp:mdf-board-prefetch'");
    expect(siderMenuItems).toContain('requestMdfBoardPrefetch(route);');
    expect(customSider).toContain('onClick: () => sider.handleNavigate(item.route)');
    expect(app).toContain('MDF_PREFETCH_COOLDOWN_MS = 25_000');
    expect(app).toContain('MDF_PREFETCH_REFRESH_MS = 25_000');
    expect(cncTelegramApi).toContain('CNC_TODAY_PREFETCH_MAX_AGE_MS = 20_000');
    expect(orderStatusBoardApi).toContain('STATUS_BOARD_PREFETCH_MAX_AGE_MS = 20_000');
    expect(app).toContain("document.visibilityState !== 'visible'");
    expect(app).toContain("window.location.pathname === '/mdf-work-board'");
    expect(app).toContain('window.setInterval(warmMdfData, MDF_PREFETCH_REFRESH_MS)');
    expect(app).toContain("document.addEventListener('visibilitychange', warmVisibleMdfData)");
    expect(app).toContain('window.clearInterval(refreshTimer)');
    expect(app).toContain("document.removeEventListener('visibilitychange', warmVisibleMdfData)");
    expect(app).toContain('window.addEventListener(MDF_BOARD_PREFETCH_EVENT, warmMdfData)');
    expect(app).toContain('window.removeEventListener(MDF_BOARD_PREFETCH_EVENT, warmMdfData)');
  });

  it('opens MDF order cards from the order number without stealing the whole-card relation click', () => {
    expect(page).toContain('data-cnc-manual-drag-ignore="true"');
    expect(page).toContain('aria-label={`Открыть заказ ${orderNumber}`}');
    expect(page).toContain('event.stopPropagation();');
    expect(page).toContain('onOpenOrder(card.orderId)');
    expect(page).toContain('onOpenOrder={(orderId) => navigate(`/orders/show/${orderId}`)}');
    expect(page).toContain("onSelectRelation({ kind: 'order', id: card.orderId })");
  });

  it('frames non-MDF machine-file cards in brown based on file metadata and comments', () => {
    expect(page).toContain('const otherMaterial = cncPacketHasOtherMaterialMarker(packet)');
    expect(page).toContain("otherMaterial ? 'cnc-packet-card--other-material' : ''");
    expect(page).toContain("data-cnc-material-kind={otherMaterial ? 'other' : undefined}");
    expect(detailedMachine).toContain("packet.programName ?? ''");
    expect(detailedMachine).toContain('...packet.comments');
    expect(detailedMachine).toContain('CNC_OTHER_MATERIAL_MARKER_PATTERN');
    expect(detailedMachine).toContain('export function cncMaterialNameIsMdf');
    expect(detailedMachine).toContain('export function cncPacketCountsForMdfReadiness');
    expect(css).toMatch(
      /\.cnc-packet-card--other-material\s*\{[^}]*border-color: #8b5a2b;[^}]*box-shadow:/s,
    );
  });

  it('auto-expands only MDF machine maps while keeping non-MDF cards manually expandable', () => {
    expect(detailedMachine).toContain("export type CncDetailedMachineMatchKind = 'exact' | 'fallback' | 'whole_order' | 'order'");
    expect(detailedMachine).toContain('otherMaterial: boolean;');
    expect(detailedMachine).toContain('autoExpand: boolean;');
    expect(page).toContain('const automaticallyExpanded = source.autoExpand && selectedDetailId !== null');
    expect(page).toContain('const expanded = automaticallyExpanded || manuallyExpanded');
    expect(page).toContain('setManuallyExpanded((current) => !current)');
    expect(page).toContain("source.matchKind === 'order'");
    expect(page).toContain('Развернуть карту файла станка');
    expect(page).toContain('Свернуть карту файла станка');
    expect(page).toContain('loadCncDetailedMachineSvgPreview(source, previewDetailId)');
    expect(css).toContain('.cnc-detailed-machine-map--other-material');
    expect(css).toContain('.cnc-detailed-machine-map__toggle.ant-btn');
  });

  it('fits detailed machine-file maps into the available viewport height', () => {
    expect(css).toContain(
      '--cnc-detailed-machine-preview-max-height: clamp(220px, calc(100dvh - 280px), 720px)',
    );
    expect(css).toMatch(
      /\.cnc-bath-card__sheet-svg\.cnc-detailed-machine-map__svg\s*\{[^}]*max-height: var\(--cnc-detailed-machine-preview-max-height\);[^}]*overflow: hidden;[^}]*display: grid;[^}]*place-items: center;/s,
    );
    expect(css).toMatch(
      /\.cnc-bath-card__sheet-svg\.cnc-detailed-machine-map__svg svg\s*\{[^}]*width: auto;[^}]*max-width: 100%;[^}]*max-height: var\(--cnc-detailed-machine-preview-max-height\);/s,
    );
    expect(css).toMatch(
      /\.cnc-detailed-machine-map__screenshot\s*\{[^}]*max-width: 100%;[^}]*height: auto;[^}]*max-height: var\(--cnc-detailed-machine-preview-max-height\);[^}]*justify-self: center;[^}]*object-fit: contain;/s,
    );
  });

  it('keeps Telegram import off the MDF board source', () => {
    expect(page).not.toContain("import { CutTelegramImportModal } from '../cut/CutTelegramImportModal';");
    expect(page).not.toContain('CutTelegramImportModal');
    expect(page).not.toContain('Импорт из Telegram');
    expect(page).not.toContain('telegramImportOpen');
    expect(page).not.toContain('canImportTelegram');
    expect(css).not.toContain('status-board-toolbar__telegram-import');
  });

  it('forces the fifth orders column compact and half-width in detailed mode', () => {
    expect(page).toContain('const summaryOnly = detailedBathActive || isCncCardSummaryOnly(');
    expect(page).toContain("displayToggleVisible={!detailedBathActive && cardDisplayMode === 'compact'}");
    expect(css).toContain('repeat(var(--status-board-cnc-side-column-count, 1), minmax(0, 0.5fr))');
    expect(page).toContain("'--status-board-cnc-side-column-count': Math.max(0, displayColumns.length - 4)");
    expect(css).toContain('.status-board-columns--cnc-detailed .cnc-today-column--orders');
    expect(css).toContain('.cnc-order-card--summary-only');
  });

  it('gives every board its own personal column settings gear', () => {
    expect(page).toContain('<StatusBoardColumnSettingsButton');
    expect(page).toContain('STATUS_BOARD_COLUMN_PREFERENCE_KEYS[viewState.view]');
    expect(page).toContain('STATUS_BOARD_COLUMN_PREFERENCE_KEYS.cnc_today');
    expect(page).toContain('filterVisibleStatusBoardColumns(');
    expect(page).toContain('showOrdersColumn={cncDetailedWorkspaceActive || cncOrdersColumnVisible}');
    expect(page).toContain('columns={cncRenderColumns}');
    expect(page).toContain('const cncPlaceholderColumns = useMemo(');
    expect(page).toContain('const cncRenderColumns = cncColumnsLoading');
    expect(page).toContain('const cncHasRenderableColumns = cncColumnsLoading');
    expect(page).toContain('const cncHasVisibleColumns = cncDetailedWorkspaceActive');
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

  it('keeps CNC display modes and empty-column filtering in its compact toolbar gear', () => {
    const settingsStart = page.indexOf('const cncSettingsContent = (');
    const settingsEnd = page.indexOf('\n\n  return (', settingsStart);
    const settings = page.slice(settingsStart, settingsEnd);
    const cncToolbarStart = page.indexOf('{isCncToday && (');
    const cncToolbarEnd = page.indexOf(
      '\n\n        {!isCncToday && !featureFlags.useBackendProductionActions',
      cncToolbarStart,
    );
    const cncToolbar = page.slice(cncToolbarStart, cncToolbarEnd);

    expect(page).toContain('extraContent={cncSettingsContent}');
    expect(page).toContain('status-board-settings__modes');
    expect(page).toContain('const [cncBathsRequireMachineFiles, setCncBathsRequireMachineFiles] =');
    expect(page).toContain('useState(true)');
    expect(page).toContain('Ванны с файлами');
    expect(page).toContain('checked={cncBathsRequireMachineFiles}');
    expect(page).toContain('filterCncBathColumnsByMachineOrderMatches(cncOrderFilteredColumns, preservedCncBathCardId)');
    expect(page).toContain('const [cncTerminalColumnsVisible, setCncTerminalColumnsVisible] = useState(false)');
    expect(page).toContain('terminalColumnsVisible={cncTerminalColumnsVisible}');
    expect(settings).toContain('checked={cncTerminalColumnsVisible}');
    expect(settings).toContain('Завершенные файлы и ванны');
    expect(page).toContain("const CNC_MOBILE_FONT_SIZE_STORAGE_PREFIX = 'erp.status-board.cnc-mobile-font-size'");
    expect(page).toContain("const CNC_MOBILE_COLUMN_SCALE_STORAGE_PREFIX = 'erp.status-board.cnc-mobile-column-scale'");
    expect(page).toContain('readCncMobileFontSizePreference(currentUser?.id)');
    expect(page).toContain('readCncMobileColumnScalePreference(currentUser?.id)');
    expect(page).toContain('writeCncMobileFontSizePreference(currentUser?.id, size)');
    expect(page).toContain('writeCncMobileColumnScalePreference(currentUser?.id, scale)');
    expect(page).toContain("return `${CNC_MOBILE_FONT_SIZE_STORAGE_PREFIX}.${userId ?? 'anonymous'}`;");
    expect(page).toContain("return `${CNC_MOBILE_COLUMN_SCALE_STORAGE_PREFIX}.${userId ?? 'anonymous'}`;");
    expect(settings).toContain('Мобильные размеры');
    expect(settings).toContain('Размер текста');
    expect(settings).toContain('Ширина скринов');
    expect(settings).toContain('options={CNC_MOBILE_FONT_SIZE_OPTIONS}');
    expect(settings).toContain('options={CNC_MOBILE_COLUMN_SCALE_OPTIONS}');
    expect(settings).toContain('updateCncMobileFontSize(value as CncMobileFontSize)');
    expect(settings).toContain('updateCncMobileColumnScale(value as CncMobileColumnScale)');
    expect(page).toContain("'--status-board-cnc-mobile-font-scale'");
    expect(page).toContain("'--status-board-cnc-mobile-column-scale'");
    expect(page).toContain("completed_laminated: 'Распиленные файлы'");
    expect(page).toContain("completed_baths: 'Завершенные ванны'");
    expect(page).toContain("baths_laminated: 'Закатаны'");
    expect(page).toContain("orders_ready: 'Готов к выдаче'");
    expect(page).toContain("orders_issued: 'Выдан'");
    expect(page).toContain('...terminalColumns');
    expect(page).toContain('cncMuted={mutedOrderIds.has(card.orderId)}');
    expect(css).toMatch(
      /\.status-board-column\.cnc-today-column--terminal\s*\{[^}]*background: #f2f3f5;/s,
    );
    expect(css).toContain('.cnc-terminal-card--muted');
    expect(settings).toContain('checked={viewState.hideEmpty}');
    expect(settings).toContain('Скрыть пустые');
    expect(settings).not.toContain('checked={viewState.cncPlannedTodayOnly}');
    expect(settings).not.toContain('Плановая дата сегодня');
    expect(cncToolbar).toContain('active={viewState.cncPlannedTodayOnly}');
    expect(cncToolbar).toContain('label="Плановая дата сегодня"');
    expect(cncToolbar).toContain('icon={<ScheduleOutlined />}');
    expect(page).toContain('const toggleCncPlannedTodayFilter = useCallback(() => {');
    expect(page).toContain('cncWorkday: todayCncWorkday');
    expect(page).toContain('cncOrderSearchPeriod: defaultCncOrderSearchPeriod');
    expect(page).toContain('cncOrderFilters: []');
    expect(page).toContain('hideEmpty: false');
    expect(page).toContain('setCncBathsRequireMachineFiles(false)');
    expect(page).toContain('setCncTerminalColumnsVisible(false)');
    expect(cncToolbar).toContain('onToggle={toggleCncPlannedTodayFilter}');
    expect(cncToolbar).not.toContain('Вчера');
    expect(cncToolbar).not.toContain('checked={viewState.hideEmpty}');
    expect(cncToolbar).not.toContain('<Typography.Text type="secondary">Период</Typography.Text>');
    expect(cncToolbar).not.toContain('<Typography.Text type="secondary">Карточки</Typography.Text>');
    expect(cncToolbar).toContain('<ProfileOutlined');
    expect(cncToolbar).toContain('className="status-board-toolbar__cnc-detail-toggle"');
    expect(cncToolbar).toContain('data-active={cncDetailedEnabled}');
    expect(cncToolbar).toContain('aria-pressed={cncDetailedEnabled}');
    expect(cncToolbar).toContain('onClick={() => setCncDetailedEnabled((current) => !current)}');
    expect(cncToolbar).toContain("cncDetailedEnabled ? 'Выключить подробный режим' : 'Включить подробный режим'");
    expect(cncToolbar.indexOf('status-board-toolbar__cnc-detail-toggle')).toBeLessThan(
      cncToolbar.indexOf('<StatusBoardColumnSettingsButton'),
    );
    expect(cncToolbar.match(/size="small"/g)?.length).toBeGreaterThanOrEqual(7);
    expect(css).toContain('.status-board-toolbar__settings-button.ant-btn');
    expect(css).toContain('margin-left: auto');
    expect(css).toContain('.status-board-settings__modes');
    expect(css).toContain('.status-board-toolbar__mobile-scale-settings');
    expect(css).toContain('.status-board-toolbar__scale-row');
    expect(css).toContain('--status-board-cnc-mobile-font-scale: 1;');
    expect(css).toContain('--status-board-cnc-mobile-column-scale: 1;');
    expect(css).toContain('font-size: calc(14px * var(--status-board-cnc-mobile-font-scale, 1))');
    expect(css).toContain('overflow-wrap: anywhere;');
    expect(css).toContain('text-wrap: pretty;');
    expect(css).toContain('max-height: calc(420px * var(--status-board-cnc-mobile-column-scale, 1));');
    expect(css).toContain('--status-board-cnc-column-width: calc(187px * var(--status-board-cnc-mobile-column-scale, 1))');
    expect(css).toMatch(/\.status-board-toolbar--cnc\s*\{[^}]*padding: 2px 6px;/);
    expect(css).toMatch(
      /\.status-board-toolbar--cnc \.status-board-toolbar__settings-button\.ant-btn\s*\{[^}]*width: 24px;[^}]*height: 24px;/s,
    );
    expect(css).toMatch(
      /\.status-board-toolbar--cnc \.status-board-toolbar__icon-toggle\.ant-btn\s*\{[^}]*width: 24px;[^}]*height: 24px;/s,
    );
    expect(css).toMatch(
      /\.status-board-toolbar__cnc-detail-toggle\.ant-btn\s*\{[^}]*margin-left: auto;[^}]*color: var\(--app-text-muted\);/s,
    );
    expect(css).toMatch(
      /\.status-board-toolbar__cnc-detail-toggle\.ant-btn\[data-active="true"\]\s*\{[^}]*color: #1677ff;/s,
    );
    expect(css).toContain('.status-board-toolbar__cnc-detail-toggle.ant-btn:active');
    expect(css).toContain('transform: scale(0.96)');
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
    expect(page).toContain('const detailed = !detailedBathActive');
    expect(page).toContain("className=\"cnc-detailed-workspace\"");
    expect(page).toContain("style={{ gridColumn: '1 / span 4', gridRow: 1 }}");
    expect(page).toContain('<CncDetailedMachineMaps');
    expect(page).toContain('buildCncDetailedMachineSources({');
    expect(page).toContain('detailedContext?.activeBath\n      ? buildCncDetailedMachineSources({');
    expect(page).toContain('selectedDetailId: number | null;');
    expect(page).toContain("source.matchKind === 'whole_order'");
    expect(page).toContain('Выберите деталь на раскладке ванны, чтобы открыть предпросмотр');
    expect(page).toContain("const canViewCncCutMaps = can('cut.view')");
    expect(page).toContain('canViewCut={canViewCncCutMaps}');
    expect(page).toContain('loadCncDetailedMachineSvgPreview(source, previewDetailId)');
    expect(page).toContain('cncDetailedMachinePreviewsShareSheets(current, preview) ? current : preview');
    expect(page).toContain('loadCncDetailedMachineScreenshot(imageUrl)');
    expect(page).toContain('syncCncBathSelectedDetail(svgBodyRef.current, previewDetailId)');
    expect(page).toContain('SVG недоступна — показан скрин');
    expect(page).toContain('Для просмотра SVG-раскладки нужен доступ к разделу «Раскрой»');
    expect(page).toContain('data-cnc-detailed-state');
    expect(page).toContain('Свернуть подробный вид ванны');
    expect(page).toContain('detailed ? false : true');
    expect(page).toContain('buildCncBathDetailOrderFillMap');
    expect(page).toContain('CNC_BATH_DETAIL_ORDER_FILL_COLORS');
    expect(page).toContain("rect.setAttribute('fill', CNC_BATH_SHEET_BACKGROUND)");
    expect(page).toContain("piece.querySelectorAll<SVGElement>('rect, path, line, polyline, polygon, circle, ellipse')");
    expect(page).toContain("contour.setAttribute('stroke', fill)");
    expect(page).toContain("contour.setAttribute('data-cnc-order-contour', 'true')");
    expect(page).toContain('enlargeCncBathDetailText(piece, 2)');
    expect(page).toContain("text.setAttribute('data-cnc-detailed-font-scale'");
    expect(page).toContain('cncBathDetailCheckPoint');
    expect(page).toContain('cncClampSvgCoordinate');
    expect(cutApi).toContain('pieceMetadata');
    expect(cutApi).toContain("params.append('pieceMetadata', 'on')");
    expect(page).toContain('decorateCncBathSheetSvg');
    expect(page).toContain('data-detail-id');
    expect(page).toContain('cnc-bath-detail-check');
    expect(page).toContain('const expanded = open;');
    expect(page).not.toContain('const expanded = detailed || open;');
    expect(page.match(/onClick=\{stopCncCardClickPropagation\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('const interactive = relationsEnabled;');
    expect(page).not.toContain('if (detailedEnabled) onSelectDetailedBath(bath.bathCardId);');
    expect(page).toContain('onOpenDetailed={() => onSelectDetailedBath(bath.bathCardId)}');
    expect(page).toContain('const [open, setOpen] = useState(detailed);');
    expect(page).toContain('if (nextOpen) onOpenDetailed();');
    expect(page).toContain('else if (detailed) onCloseDetailed();');
    expect(page).toContain('syncCncBathSelectedDetail(sheetBodyRef.current, selectedDetailId)');
    expect(page).toContain('loadedPreviewKeyRef.current = releaseCncPreviewLoadKey(');
    expect(page).toContain('const loadedPdfKeyRef = useRef<string | null>(null)');
    expect(page).toContain('loadedPdfKeyRef.current === pdfPreviewKey');
    expect(page).toContain('loadedPdfKeyRef.current = pdfPreviewKey');
    expect(page).toContain('isCncPreviewRequestCurrent(cancelled, requestSeqRef.current, requestSeq)');
    expect(page).toMatch(
      /const previewKey = useMemo\([\s\S]*?\[bath\.cutJobId, bath\.resultNo, bath\.sheets, completedKey, detailed, orderFillKey\],/,
    );
    expect(page).not.toMatch(
      /const previewKey = useMemo\([\s\S]*?\[[^\]]*selectedDetailId[^\]]*\],/,
    );
    expect(page).toContain('getCncPacketDisplayState');
    expect(page).toContain('cncDetailFingerprintsIntersect');
    expect(page).toContain('cncPacketWholeOrderIntersects');
    expect(css).toContain('.status-board-columns--cnc-detailed .cnc-today-column--detailed-covered');
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('.cnc-detailed-workspace');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toContain('.cnc-detailed-workspace__machine');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('scrollbar-gutter: stable');
    expect(css).toContain(
      'grid-template-columns: repeat(var(--status-board-cnc-column-count, 5), minmax(0, 1fr));',
    );
    expect(page).toContain('const packetState = entry.state;');
    expect(page).toMatch(
      /const summaryOnly = isCncCardSummaryOnly\([\s\S]*?cardKey,\s+detailedPacketHighlightEnabled && packetState === 'related',\s+\);/,
    );
    expect(page).toContain('relationState={packetState}');
    expect(css).toContain('.cnc-bath-card--detailed');
    expect(css).toContain('--status-board-cnc-column-gap: clamp(4px, 0.8vw, 12px);');
    expect(css).toMatch(
      /\.cnc-detailed-workspace__bath \.cnc-bath-card--detailed\s*\{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*margin-left: 0;/s,
    );
    expect(css).toMatch(
      /@container status-board-viewport \(max-width: 960px\)[\s\S]*?\.status-board-columns--cnc-detailed \.cnc-bath-card--detailed \.cnc-packet-card__sheet[^}]*\{[^}]*display: block;/,
    );
    expect(css).toMatch(
      /\.status-board-columns--cnc-detailed \.cnc-packet-card\[data-cnc-relation-state="related"\] \.cnc-packet-card__program[^}]*\{[^}]*display: block;/,
    );
    expect(css).toContain('isolation: isolate');
    expect(css).toContain('font-size: 10px');
    expect(css).toContain('.cnc-bath-card__detail-close');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-detail-id]');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-cnc-order-contour="true"]');
    expect(css).toContain('.cnc-bath-card__sheet-svg [data-cnc-selected-detail="true"] > rect:first-child');
  });

  it('keeps bath detail and PDF controls side by side and opens PDF only in a full preview modal', () => {
    expect(page).toContain("useState<'items' | 'pdf' | null>(null)");
    expect(page).toContain('className="cnc-bath-card__tabs"');
    expect(page).toContain("activeAuxView === 'items'");
    expect(page).toContain("activeAuxView === 'pdf'");
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain('className="cnc-bath-card__pdf-modal"');
    expect(page).toContain('width="min(96vw, 1440px)"');
    expect(page).not.toContain('className="cnc-packet-card__sheet cnc-bath-card__pdf"');
    expect(css).toMatch(
      /\.cnc-bath-card__tabs\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.cnc-bath-card__tab\.ant-btn\s*\{[^}]*height: 22px;[^}]*min-height: 22px;[^}]*font-size: 10px;/s,
    );
    expect(css).toContain('.cnc-bath-card__pdf-modal');
  });

  it('keeps MDF machine file details and sheet preview as exclusive side-by-side tabs', () => {
    const packetCardStart = page.indexOf('const CncTelegramPacketCard =');
    const packetCardEnd = page.indexOf('interface CncTelegramSheetImagePreviewProps', packetCardStart);
    const packetCard = page.slice(packetCardStart, packetCardEnd);
    const sheetPreviewEnd = page.indexOf('interface CncTelegramBathCardViewProps', packetCardEnd);
    const sheetPreview = page.slice(packetCardEnd, sheetPreviewEnd);

    expect(packetCard).toContain("useState<'items' | 'sheet' | null>(null)");
    expect(packetCard).toContain('className="cnc-packet-card__tabs"');
    expect(packetCard).toContain("activeAuxView === 'items'");
    expect(packetCard).toContain("activeAuxView === 'sheet'");
    expect(packetCard).toContain("current === 'items' ? null : 'items'");
    expect(packetCard).toContain("current === 'sheet' ? null : 'sheet'");
    expect(packetCard).toContain('className="cnc-packet-card__items-panel"');
    expect(packetCard).not.toContain('className="cnc-packet-card__collapse compact-collapse"');
    expect(sheetPreview).toContain('open: boolean;');
    expect(sheetPreview).toContain('if (!open) return null;');
    expect(sheetPreview).toContain('className="cnc-packet-card__sheet-panel"');
    expect(sheetPreview).toContain('className="cnc-packet-card__sheet-actions"');
    expect(sheetPreview).toContain('<CncPinchZoomImage');
    expect(sheetPreview).toContain('viewportClassName="cnc-pinch-zoom--packet-sheet"');
    expect(sheetPreview).toContain('const canGenerateLabels = labelDetailInstances.length > 0 && (hasCutSheetScope || cutMapFallbackImage !== null)');
    expect(sheetPreview).toContain('cutMapFallbackImage={hasCutSheetScope ? null : cutMapFallbackImage}');
    expect(sheetPreview).toContain('aria-haspopup="dialog"');
    expect(sheetPreview).not.toContain('printSheetImage');
    expect(sheetPreview.match(/<LazyCutSheetLabelGenerateAction/g)).toHaveLength(1);
    expect(sheetPreview.match(/onClick=\{\(\) => setPrintPreviewOpen\(true\)\}/g)).toHaveLength(1);
    expect(sheetPreview).not.toContain('cnc-packet-card__sheet-toolbar');
    expect(sheetPreview).toContain('<ImagePrintPreviewModal');
    expect(sheetPreview).toContain("status={generatedSvgPreview ? 'SVG-раскрой из задания' : 'Скрин из Telegram-чата'}");
    expect(sheetPreview).toContain('printHeader={printHeader}');
    expect(packetCard).toContain('cutJobDisplayNumber={cncPacketDisplayCutJobNumber(packet)}');
    expect(sheetPreview).toContain('cutJobDisplayNumber,');
    expect(sheetPreview).toContain("previewSource === 'screenshot' && printHeader");
    expect(sheetPreview).toContain('className="cnc-packet-card__sheet-heading"');
    expect(css).toMatch(/\.cnc-packet-card__sheet-heading\s*\{[^}]*font-weight:\s*400;/s);
    expect(page).toContain('cutJobDisplayNumber: formatCncBathCardCutNumber(bath),');
    expect(sheetPreview).toContain('printMode="stretch-page-height"');
    expect(packetCard).toContain('const sheetPrintHeader = cncMachineFileCutPrintHeader(packet);');
    expect(page).toContain('function cncMachineFileCutPrintHeader(packet: CncTelegramPacket)');
    expect(page).toContain('return `Раскрой №${cardNumber}`;');
    expect(imagePrintPreview).toContain('export const DEFAULT_IMAGE_PREVIEW_SCALE = 0.25;');
    expect(imagePrintPreview).toContain('printHeader?: string;');
    expect(imagePrintPreview).toContain("type ImagePrintMode = 'contain' | 'stretch-page-height';");
    expect(imagePrintPreview).toContain('printMode?: ImagePrintMode;');
    expect(imagePrintPreview).toContain('printImage(imageUrl, printTitle, printHeader, printMode)');
    expect(imagePrintPreview).toContain('class="image-print-header"');
    expect(imagePrintPreview).toContain('font-size:20px');
    expect(imagePrintPreview).toContain('@page{size:portrait;margin:8mm}');
    expect(imagePrintPreview).toContain('min-height:85vh');
    expect(imagePrintPreview).toContain('object-fit:fill');
    expect(imagePrintPreview).toContain('ZoomOutOutlined');
    expect(imagePrintPreview).toContain('ZoomInOutlined');
    expect(imagePrintPreview).toContain('Печать скрина');
    expect(imagePrintPreview).toMatch(/frame\.contentWindow\?\.print\(\)/);
    expect(css).toMatch(
      /\.cnc-packet-card__tabs\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    );
    expect(css).toMatch(
      /\.cnc-packet-card__tab\.ant-btn\s*\{[^}]*height: 22px;[^}]*min-height: 22px;[^}]*font-size: 10px;/s,
    );
    expect(css).toContain('.cnc-packet-card__tab.ant-btn[aria-pressed="true"]');
    expect(css).toContain('.cnc-packet-card__items-panel');
    expect(css).toContain('.cnc-packet-card__sheet-panel');
    expect(css).toMatch(/\.cnc-packet-card__sheet-actions \.ant-btn\s*\{[^}]*min-height: 40px;/s);
  });

  it('shows the bath cut job name only inside detail and PDF preview headers', () => {
    expect(page).not.toContain('className="cnc-bath-card__job"');
    expect(page).toContain('className="cnc-bath-card__block-heading"');
    expect(page).toContain('className="cnc-bath-card__block-heading cnc-bath-card__block-heading--modal"');
    expect(page).toContain('className="cnc-bath-card__block-job" title={bath.cutJobName}');
    expect(page).toContain('Список деталей');
    expect(page).toContain('const bathDisplayCutNumber = formatCncBathCardCutNumber(bath);');
    expect(page).toContain('Предпросмотр PDF · раскрой {bathDisplayCutNumber}');
    expect(page).not.toContain('Предпросмотр PDF · раскрой №{bath.cutNumber}');
    expect(css).toContain('.cnc-bath-card__block-heading');
    expect(css).toContain('.cnc-bath-card__block-job');
  });

  it('keeps order cards dense, badge-based and project-code-free', () => {
    expect(page).toContain("type StatusBoardCardDisplayMode = 'standard' | 'compact' | 'minimal'");
    expect(page).toContain("useState<StatusBoardCardDisplayMode>('compact')");
    expect(page).toContain('STATUS_BOARD_CARD_DISPLAY_OPTIONS');
    expect(page).toContain('Вид карточек заказов');
    expect(page).toContain('Стандартный');
    expect(page).toContain('Средний');
    expect(page).toContain('Компактный');
    expect(page).not.toContain('Минимальный');
    expect(page).toContain('formatStatusBoardOrderNumber(card)');
    expect(page).toContain('trimmedText(card.orderName) || String(card.orderId)');
    expect(page).not.toContain('card.orderName.trim() || String(card.orderId)');
    expect(page).not.toContain('card.fullNumber');
    expect(page).not.toContain('primaryStatusLabel');
    expect(page).not.toContain('status-board-card__status-label');
    expect(page).toContain('resolveStatusBoardStatusColor(board, card, allColumns)');
    expect(page).toContain('color={primaryStatusColor}');
    expect(page).toContain('status-board-card__identity');
    expect(page).toContain('status-board-card__status-badge');
    expect(page).toContain('status-board-card__standard-grid');
    expect(page).toContain('productionToolbarCompact');
    expect(page).toContain('status-board-toolbar--production');
    expect(page).toContain('StatusBoardToolbarIconToggle');
    expect(page).toContain('STATUS_BOARD_CARD_DISPLAY_ICONS');
    expect(page).toContain('productionCardDisplayOptions');
    expect(page).toContain('placeholder={productionToolbarCompact ?');
    expect(page).toContain('prefix={<SearchOutlined />}');
    expect(page).toContain('status-board-columns--${activeBoard}');
    expect(page).toContain("cardDisplayMode !== 'standard' ? 'status-board-columns--narrow-cards' : ''");
    expect(css).toContain('.status-board-toolbar__display-mode');
    expect(css).toContain('width: min(160px, 100%)');
    expect(css).toContain('.status-board-toolbar__date-range');
    expect(css).toContain('width: 224px');
    expect(css).toContain('flex-wrap: nowrap');
    expect(css).toContain('.status-board-toolbar--production');
    expect(css).toContain('overflow-x: visible');
    expect(css).toContain('.status-board-toolbar__icon-toggle.ant-btn');
    expect(css).toContain('.status-board-toolbar__display-mode-icon');
    expect(css).toContain('.status-board-toolbar--production .status-board-toolbar__display-mode-label');
    expect(css).toContain('.status-board-card--compact');
    expect(css).toContain('.status-board-card--minimal');
    expect(css).toContain('.status-board-columns--narrow-cards:not(.status-board-columns--cnc) .status-board-column');
    expect(css).toContain('width: 182px');
    expect(css).toContain('min-width: 182px');
    expect(css).toContain('width: calc((100vw - 48px) * 0.6)');
    expect(css).toContain('.status-board-card__identity');
    expect(css).toContain('.status-board-card__status-badge.ant-tag');
    expect(css).toContain('.status-board-columns--narrow-cards:not(.status-board-columns--cnc) .status-board-card__number.ant-btn');
    expect(css).toContain('.status-board-columns--narrow-cards:not(.status-board-columns--cnc) .status-board-card__status-badge.ant-tag');
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
    expect(css).toContain('.status-board-columns--narrow-cards:not(.status-board-columns--cnc) .status-board-card--compact .status-board-card__compact-text');
    expect(css).toContain('white-space: normal');
    expect(css).toContain('word-break: normal');
  });

  it('keeps original MDF placement behind gear settings with read-only current-location tooltips', () => {
    expect(page).toContain("useState<CncBoardPlacementMode>('current')");
    expect(page).toContain('Исходный (2 месяца)');
    expect(page).toContain("cncTelegramApi.originalBoard({ cache: 'no-store' })");
    expect(page).toContain('buildCncOriginalSourceColumns(cncOriginalBoard)');
    expect(page).toContain('movesEnabled={!originalMode}');
    expect(page).toContain("trigger={['hover', 'focus']}");
    expect(page).toContain('Текущее положение:');
  });
});
