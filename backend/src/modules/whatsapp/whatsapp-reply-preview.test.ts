import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../permissions/require-permissions.decorator';
import { parseRuleInput, parseRuleUpdate, parseTemplateInput, parseTemplateUpdate } from './whatsapp.dto';
import { createHmac } from 'node:crypto';

describe('reply preview and inbound identity', () => {
  it('keeps legacy DTO defaults and omission-safe patches', () => {
    expect(parseTemplateInput({ code: 'test', name: 'Тест', body: '{}' }).bodyMode).toBe('text');
    expect(parseRuleInput({ code: 'test', name: 'Тест', templateId: 1, keywords: ['ГОТОВ'], matchMode: 'exact_any' }).replyMode).toBe('plain');
    expect(parseRuleUpdate({ version: 1 })).not.toHaveProperty('replyMode');
    expect(parseTemplateUpdate({ version: 1 })).not.toHaveProperty('bodyMode');
  });
  it('previews without DB/provider access and requires manage permission', () => {
    const repo = {}, client = {};
    const service = new WhatsAppService({ getConfig: () => ({ enabled: true }) } as never, repo as never, client as never, {} as never, {} as never);
    expect(service.previewReply({ matchMode: 'pattern_exact', keywords: ['Заказ {id:number} готов'], body: '{id} / {counter}', bodyMode: 'template', text: 'ЗАКАЗ 0022 готов' }))
      .toMatchObject({ matched: true, captures: { id: '0022' }, body: '0022 / 1', counterIsExample: true });
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, WhatsAppController.prototype.preview)).toEqual(['whatsapp.manage']);
    const response = { setHeader: vi.fn() };
    new WhatsAppController(service).preview({ matchMode: 'exact_any', keywords: ['готов'], body: 'OK', bodyMode: 'text', text: 'нет' }, response as never);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
  it('keeps the original payload ID separate from hashed dedup and redacts logs', async () => {
    const secret = 's'.repeat(32), rawId = 'false_123@lid_ABC';
    const body = Buffer.from(JSON.stringify({ event: 'message', session: 'erp', payload: { id: rawId, from: '123@lid', fromMe: false, body: 'Тест', hasMedia: false } }));
    const acceptInbound = vi.fn().mockResolvedValue({ duplicate: false, result: 'queued' }), record = vi.fn();
    const service = new WhatsAppService({ getConfig: () => ({ enabled: true, webhookSecret: secret, sessionName: 'erp' }) } as never,
      { acceptInbound } as never, {} as never, {} as never, { record } as never);
    await service.webhook(body, createHmac('sha512', secret).update(body).digest('hex'), 'sha512', String(Date.now()), 'test-request');
    expect(acceptInbound.mock.calls[0][0]).toMatchObject({ externalEventId: expect.stringMatching(/^h1:/), providerMessageId: rawId, chatId: '123@lid' });
    expect(JSON.stringify(record.mock.calls)).not.toContain(rawId);
  });
});
