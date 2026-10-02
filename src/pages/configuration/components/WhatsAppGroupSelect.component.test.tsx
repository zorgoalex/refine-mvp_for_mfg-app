import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackMounted, WhatsAppGroupSelect } from './WhatsAppGroupSelect';
import { WhatsAppGroupLabel } from './WhatsAppGroupLabel';
import { loadWhatsAppGroups, resetWhatsAppGroupsCacheForTests } from './whatsappGroupsCache';

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

async function render(value: string) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<WhatsAppGroupSelect value={value} onChange={() => undefined} />);
  });
  return renderer;
}

const listResponse = { groups: [group], truncated: false, fetchedAt: '2026-09-29T10:00:00.000Z', cached: false };

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
  afterEach(() => { mockGroups.mockReset(); resetWhatsAppGroupsCacheForTests(); });

  it('an empty field never loads before user action', async () => {
    mockGroups.mockResolvedValue(listResponse);
    const renderer = await render('');
    expect(mockGroups).not.toHaveBeenCalled();
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(1);
    const options = renderer.root.findByProps({ 'data-testid': 'group-picker' }).props.options as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual([group.id]);
  });

  it('a saved group shows its name next to the id without user action, loading once', async () => {
    mockGroups.mockResolvedValue(listResponse);
    const renderer = await render(group.id);
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain('ЧПУ');
    expect(textOf(renderer)).toContain('Пишут только администраторы');
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(1);
  });

  it('marks a saved id that the account does not have', async () => {
    mockGroups.mockResolvedValue(listResponse);
    const renderer = await render('120363000000000999@g.us');
    expect(textOf(renderer)).toContain('Нет в списке групп аккаунта');
  });

  it('retries after a failure once the user opens the list again', async () => {
    mockGroups
      .mockRejectedValueOnce(Object.assign(new Error('not ready'), { name: 'ApiError' }))
      .mockResolvedValueOnce(listResponse);
    const renderer = await render(group.id);
    expect(textOf(renderer)).toContain('Список групп недоступен');
    await focus(renderer);
    expect(mockGroups).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain('Список групп недоступен');
    expect(textOf(renderer)).toContain('ЧПУ');
  });
});

describe('WhatsAppGroupLabel', () => {
  afterEach(() => { mockGroups.mockReset(); resetWhatsAppGroupsCacheForTests(); });

  async function label(id: string | null) {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<WhatsAppGroupLabel id={id} />); });
    return renderer;
  }

  it('shows the name with the masked id and shares one request between labels', async () => {
    mockGroups.mockResolvedValue(listResponse);
    const [first, second] = await Promise.all([label(group.id), label(group.id)]);
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(textOf(first)).toBe('ЧПУ · 1203…@g.us');
    expect(textOf(second)).toBe('ЧПУ · 1203…@g.us');
  });

  it('falls back to the masked id when the list is unavailable or the group is unknown', async () => {
    mockGroups.mockRejectedValueOnce(new Error('offline'));
    expect(textOf(await label(group.id))).toBe('1203…@g.us');
    mockGroups.mockResolvedValueOnce(listResponse);
    expect(textOf(await label('120363000000000999@g.us'))).toBe('1203…@g.us');
    expect(textOf(await label(null))).toBe('не задана');
  });
});

describe('loadWhatsAppGroups', () => {
  afterEach(() => { mockGroups.mockReset(); resetWhatsAppGroupsCacheForTests(); });

  it('reuses a success for a minute and does not remember failures', async () => {
    mockGroups.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(listResponse);
    await expect(loadWhatsAppGroups(0)).rejects.toThrow('offline');
    await expect(loadWhatsAppGroups(0)).resolves.toEqual([group]);
    expect(mockGroups).toHaveBeenCalledTimes(2);
    await loadWhatsAppGroups(Date.now() + 59_000);
    expect(mockGroups).toHaveBeenCalledTimes(2);
    await loadWhatsAppGroups(Date.now() + 61_000);
    expect(mockGroups).toHaveBeenCalledTimes(3);
  });
});
