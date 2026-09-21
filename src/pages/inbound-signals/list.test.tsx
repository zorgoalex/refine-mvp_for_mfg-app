import React from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../../utils/permissions', () => ({ can: (permission: string) => state.permissions.includes(permission) }));
vi.mock('../../api/inboundSignalsApi', () => ({ inboundSignalsApi: {} }));
import { InboundSignalsList } from './list';
import { MessageProcessingConfig } from '../configuration/components/MessageProcessingConfig';
import { signalLabel } from './labels';

describe('standalone incoming signals permissions and readable state', () => {
  beforeEach(() => { state.permissions = []; });
  it('denies the standalone page without permission', () => {
    expect(renderToString(<InboundSignalsList />)).toContain('Нет доступа к входящим сигналам');
  });
  it('manager sees the independent screen but no diagnostic switch', () => {
    state.permissions = ['message_signals.view'];
    const html = renderToString(<InboundSignalsList />);
    expect(html).toContain('Входящие сигналы'); expect(html).toContain('Поиск в сообщениях');
    expect(html).not.toContain('Технический вид'); expect(html).not.toContain('Включая сообщения без совпадений');
  });
  it('technical mode and unmatched messages require their separate permissions', () => {
    state.permissions = ['message_signals.view','message_signals.technical','message_signals.resolve'];
    const html = renderToString(<InboundSignalsList />);
    expect(html).toContain('Технический вид'); expect(html).toContain('Включая сообщения без совпадений');
  });
  it('configuration is unavailable to view-only roles', () => {
    state.permissions = ['message_signals.view'];
    expect(renderToString(<MessageProcessingConfig />)).toContain('Нет прав на настройку');
  });
  it('uses readable labels and a safe unknown-code fallback', () => {
    expect(signalLabel('retry_wait')).toBe('Повторим автоматически');
    expect(signalLabel('new_provider_code')).toBe('Требуется проверка');
    expect(signalLabel(null)).toBe('Ключевых слов не найдено');
  });
});
