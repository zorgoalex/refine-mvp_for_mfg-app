import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const component = readFileSync(new URL('./OrderTelegramScreenshots.tsx', import.meta.url), 'utf8');
const filesBlock = readFileSync(new URL('./OrderFilesBlock.tsx', import.meta.url), 'utf8');
const filesSection = readFileSync(new URL('./OrderFilesSection.tsx', import.meta.url), 'utf8');
const orderForm = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../../styles/app.css', import.meta.url), 'utf8');

describe('order Telegram screenshot UI wiring', () => {
  it('mounts permanent thumbnails in read and edit file surfaces', () => {
    expect(filesBlock).toMatch(/OrderTelegramScreenshots orderId=\{Number\(record\?\.order_id\)\}/);
    expect(filesSection).toMatch(/const resolvedOrderId = header\.order_id \?\? orderId/);
    expect(filesSection).toMatch(/OrderTelegramScreenshots orderId=\{Number\(resolvedOrderId\)\}/);
    expect(orderForm).toMatch(/OrderTelegramScreenshots orderId=\{header\.order_id \?\? orderId\}/);
    expect(orderForm).toMatch(/OrderFilesSection orderId=\{header\.order_id \?\? orderId\}/);
    expect(component).toContain('Скрины раскроя');
    expect(component).toMatch(/downloadOrderScreenshotPreview/);
    expect(component).toMatch(/fetchSvgCutScreenshotBlob/);
  });

  it('opens fullscreen viewer with zoom, print, close and authenticated blob cleanup', () => {
    expect(component).toContain('width="calc(100vw - 24px)"');
    expect(component).toContain('const DEFAULT_SCALE = 0.25;');
    expect(component).toMatch(/useState\(DEFAULT_SCALE\)/);
    expect(component.match(/setScale\(DEFAULT_SCALE\)/g)).toHaveLength(3);
    expect(component).toContain('ZoomOutOutlined');
    expect(component).toContain('ZoomInOutlined');
    expect(component).toContain('Печать');
    expect(component).toContain('Закрыть просмотр');
    expect(component).toMatch(/URL\.revokeObjectURL/);
    expect(component).toMatch(/frame\.contentWindow\?\.print\(\)/);
  });

  it('restores expired originals through worker polling while retaining the preview', () => {
    expect(component).toMatch(/restoreOrderScreenshot/);
    expect(component).toMatch(/RESTORE_POLL_MS = 2_500/);
    expect(component).toContain('Восстанавливаем оригинал из Telegram');
    expect(component).toContain('Сохранённое превью');
    expect(component).toMatch(/item\.restore\?\.status === 'failed'/);
  });

  it('gates automatic reads and rejects stale lifecycle/auth publication', () => {
    expect(component).toMatch(/useOrderAsyncReadGuard/);
    expect(component).toMatch(/readGuard\.capture\(\)/);
    expect(component).toMatch(/readGuard\.isCurrent\(token\)/);
    expect(component).toMatch(/!readGuard\.active \|\| !validOrderId/);
    expect(component).toMatch(/responseState\?\.scopeKey === readScopeKey/);
    expect(component).toMatch(/thumbnailGuard\.capture\(\)/);
    expect(component).toMatch(/thumbnailGuard\.isCurrent\(token\)/);
    expect(component).toMatch(/thumbnailState\?\.scopeKey === thumbnailScopeKey/);
    expect(component).toMatch(/downloadGuard\.capture\(\)/);
    expect(component).toMatch(/downloadGuard\.isSameResource\(downloadToken\)/);
    expect(component).toMatch(/downloadState\?\.scopeKey === downloadScopeKey/);
  });

  it('applies image outlines, 40px controls and interruptible explicit transitions', () => {
    expect(css).toContain('outline: 1px solid rgba(0, 0, 0, 0.1)');
    expect(css).toContain('outline: 1px solid rgba(255, 255, 255, 0.1)');
    expect(css).toMatch(/min-width: 40px;\s*\n\s*height: 40px/);
    expect(css).toContain('transition-property: box-shadow, scale');
    expect(css).not.toContain('.order-telegram-screenshot-card {\n  transition: all');
  });
});
