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
    expect(filesSection).toMatch(/OrderTelegramScreenshots orderId=\{Number\(header\.order_id\)\}/);
    expect(orderForm).toMatch(/OrderTelegramScreenshots orderId=\{header\.order_id \?\? orderId\}/);
    expect(component).toContain('Скрины раскроя из Telegram');
    expect(component).toMatch(/downloadOrderScreenshotPreview/);
  });

  it('opens fullscreen viewer with zoom, print, close and authenticated blob cleanup', () => {
    expect(component).toContain('width="calc(100vw - 24px)"');
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

  it('applies image outlines, 40px controls and interruptible explicit transitions', () => {
    expect(css).toContain('outline: 1px solid rgba(0, 0, 0, 0.1)');
    expect(css).toContain('outline: 1px solid rgba(255, 255, 255, 0.1)');
    expect(css).toMatch(/min-width: 40px;\s*\n\s*height: 40px/);
    expect(css).toContain('transition-property: box-shadow, scale');
    expect(css).not.toContain('.order-telegram-screenshot-card {\n  transition: all');
  });
});
