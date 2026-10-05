import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Вид балуна (запрос пользователя 2026-10-03): текст на 20% мельче, серый заметный контур, светло-голубой фон.
const css = readFileSync(resolve(__dirname, '../../styles/app.css'), 'utf8');
const center = readFileSync(resolve(__dirname, './BalloonCenter.tsx'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('balloon look', () => {
  it('every balloon of the center carries the look class', () => {
    expect(center).toContain("export const BALLOON_CLASS_NAME = 'app-balloon';");
    expect(center).toContain('className: BALLOON_CLASS_NAME,');
  });

  it('text is 20% smaller than the antd notification (16 → 12.8px title, 14 → 11.2px text)', () => {
    expect(rule('body .ant-notification .app-balloon .ant-notification-notice-message')).toContain('font-size: 12.8px;');
    expect(rule('body .ant-notification .app-balloon .ant-notification-notice-description')).toContain('font-size: 11.2px;');
  });

  it('visible grey outline and a light blue background (dark theme keeps the outline)', () => {
    const notice = rule('body .ant-notification .ant-notification-notice.app-balloon');
    expect(notice).toContain('background: #e6f4ff;');
    expect(notice).toContain('border: 1px solid #8c8c8c;');
    expect(rule('[data-theme="dark"] body .ant-notification .ant-notification-notice.app-balloon')).toContain('border-color: #8c8c8c;');
  });
});
