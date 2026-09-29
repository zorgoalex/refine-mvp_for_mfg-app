import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackMounted, WhatsAppGroupSelect } from './WhatsAppGroupSelect';

const mockGroups = vi.hoisted(() => vi.fn());
vi.mock('../../../api/whatsappApi', () => ({ whatsappApi: { groups: mockGroups } }));
vi.mock('antd', () => {
  const passthrough = (tag: string) => ({ children }: { children?: React.ReactNode }) => React.createElement(tag, null, children);
  return {
    AutoComplete: (props: Record<string, unknown>) => React.createElement('input', { 'data-testid': 'group-picker', ...props }),
    Space: passthrough('span'),
    Typography: { Text: passthrough('span') },
  };
});

const group = { id: '120363000000000001@g.us', name: 'ЧПУ', participantCount: 12, announceOnly: true, communityParent: false, suspended: false };

function textOf(renderer: ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const children = (node as { children?: unknown }).children;
    return children ? collect(children) : '';
  };
  return collect(renderer.toJSON());
}

async function focus(renderer: ReactTestRenderer) {
  const picker = renderer.root.findByProps({ 'data-testid': 'group-picker' });
  await act(async () => { (picker.props.onFocus as () => void)(); });
}

function render(value: string) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<WhatsAppGroupSelect value={value} onChange={() => undefined} />);
  });
  return renderer;
}

describe('trackMounted', () => {
  // react-test-renderer 18.2 does not replay effects under StrictMode, so the
  // setup → cleanup → setup sequence of the app's createRoot is exercised directly.
  it('stays mounted after the StrictMode effect replay and clears on unmount', () => {
    const ref = { current: false };
    const firstCleanup = trackMounted(ref);
    firstCleanup();
    const cleanup = trackMounted(ref);
    expect(ref.current).toBe(true);
    cleanup();
    expect(ref.current).toBe(false);
  });
});

describe('WhatsAppGroupSelect', () => {
  afterEach(() => mockGroups.mockReset());

  it('shows loaded groups and never loads before user action', async () => {
    mockGroups.mockResolvedValue({ groups: [group], truncated: false, fetchedAt: '2026-09-29T10:00:00.000Z', cached: false });
    const renderer = render(group.id);
    expect(mockGroups).not.toHaveBeenCalled();
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('Группа: ЧПУ');
    expect(textOf(renderer)).toContain('Пишут только администраторы');
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(1);
    const options = renderer.root.findByProps({ 'data-testid': 'group-picker' }).props.options as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual([group.id]);
  });

  it('retries after a failure once the user opens the list again', async () => {
    mockGroups
      .mockRejectedValueOnce(Object.assign(new Error('not ready'), { name: 'ApiError' }))
      .mockResolvedValueOnce({ groups: [group], truncated: false, fetchedAt: '2026-09-29T10:00:00.000Z', cached: false });
    const renderer = render(group.id);
    await focus(renderer);
    expect(textOf(renderer)).toContain('Список групп недоступен');
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain('Список групп недоступен');
    expect(textOf(renderer)).toContain('Группа: ЧПУ');
  });
});
