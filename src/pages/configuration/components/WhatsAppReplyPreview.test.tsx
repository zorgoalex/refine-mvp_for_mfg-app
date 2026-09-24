import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppReplyPreview, splitWhatsAppKeywords } from './WhatsAppReplyPreview';
import { whatsappApi } from '../../../api/whatsappApi';
vi.mock('../../../api/whatsappApi', () => ({ whatsappApi: { preview: vi.fn() } }));
vi.mock('antd', () => ({
  Button: (p: Record<string, unknown>) => React.createElement('button', p),
  Card: (p: Record<string, unknown>) => React.createElement('section', p),
  Space: (p: Record<string, unknown>) => React.createElement('div', p),
  Alert: (p: Record<string, unknown>) => React.createElement('aside', p),
  Input: { TextArea: (p: Record<string, unknown>) => React.createElement('textarea', p) },
  Typography: { Text: (p: Record<string, unknown>) => React.createElement('span', p) },
}));
let tree: ReactTestRenderer | undefined;
const edit = (value: string) => act(() => tree!.root.findByType('textarea').props.onChange({ target: { value } }));
const click = () => act(async () => { tree!.root.findByType('button').props.onClick(); });
const rendered = () => JSON.stringify(tree!.toJSON());
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; vi.clearAllMocks(); });
describe('WhatsApp dry preview', () => {
  it('keeps commas in patterns, but splits legacy keywords', () => {
    expect(splitWhatsAppKeywords('Заказ {id:number}, готов\nГотов {id:number}', 'pattern_exact')).toHaveLength(2);
    expect(splitWhatsAppKeywords('готов,завершён\nок', 'contains_any')).toHaveLength(3);
  });
  it('shows captures and answer; invalidates preview after editing', async () => {
    vi.mocked(whatsappApi.preview).mockResolvedValue({ matched: true, captures: { id: '0022' }, body: 'Ответ 0022', counterIsExample: true, timeZone: 'Asia/Almaty' });
    await act(async () => { tree = create(<WhatsAppReplyPreview matchMode="pattern_exact" keywordText="Заказ {id:number} готов" body="Ответ {id}" bodyMode="template" />); });
    edit('Заказ 0022 готов'); await click();
    expect(rendered()).toContain('Ответ 0022');
    edit('Другое'); expect(rendered()).not.toContain('Ответ 0022');
    expect(whatsappApi.preview).toHaveBeenCalledTimes(1);
  });
  it('does not display a stale response and renders errors', async () => {
    let finish!: (value: Awaited<ReturnType<typeof whatsappApi.preview>>) => void;
    vi.mocked(whatsappApi.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { tree = create(<WhatsAppReplyPreview matchMode="exact_any" keywordText="готов" body="Ответ" />); });
    edit('готов'); await click();
    act(() => tree!.update(<WhatsAppReplyPreview matchMode="exact_any" keywordText="другое" body="Новый ответ" />));
    await act(async () => finish({ matched: true, captures: {}, body: 'Старый ответ', counterIsExample: true, timeZone: 'Asia/Almaty' }));
    expect(rendered()).not.toContain('Старый ответ');
    vi.mocked(whatsappApi.preview).mockRejectedValueOnce(new Error('Проверьте переменную'));
    await click(); expect(rendered()).toContain('Проверьте переменную');
  });
});
