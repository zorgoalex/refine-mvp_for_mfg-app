import { describe, expect, it } from 'vitest';
import { parseDailyDigestSettingsInput } from './daily-digest.dto';

const valid={version:1,enabled:false,groupChatId:null,sendTime:'08:45',cardsPerMessage:2,catchUpPolicy:'until_deadline',catchUpDeadline:'10:00',partialPolicy:'remaining',duplicateRiskConfirmed:false};

describe('daily digest settings DTO',()=>{
  it('accepts legacy and modern WhatsApp group identifiers',()=>{
    expect(parseDailyDigestSettingsInput({...valid,groupChatId:'123456789012345@g.us'}).groupChatId).toBe('123456789012345@g.us');
    expect(parseDailyDigestSettingsInput({...valid,groupChatId:'1234567890-1234567890@g.us'}).groupChatId).toBe('1234567890-1234567890@g.us');
  });

  it.each(['77001234567@c.us','12345@lid','https://example.test','123@g.us','1234567890-123@g.us'])(
    'rejects a non-group target %s',groupChatId=>{
      expect(()=>parseDailyDigestSettingsInput({...valid,groupChatId})).toThrow();
    },
  );

  it('requires explicit duplicate-risk acknowledgement for repeat-all and group for enabled mode',()=>{
    try { parseDailyDigestSettingsInput({...valid,partialPolicy:'repeat_all'}); throw new Error('expected confirmation failure'); }
    catch (error) { expect(error).toMatchObject({code:'WHATSAPP_DAILY_DIGEST_DUPLICATE_CONFIRMATION_REQUIRED'}); }
    expect(()=>parseDailyDigestSettingsInput({...valid,enabled:true})).toThrow();
    expect(parseDailyDigestSettingsInput({...valid,partialPolicy:'repeat_all',duplicateRiskConfirmed:true}).partialPolicy).toBe('repeat_all');
  });

  it('rejects a catch-up deadline before scheduled send time',()=>{
    expect(()=>parseDailyDigestSettingsInput({...valid,sendTime:'10:00',catchUpDeadline:'09:59'})).toThrow();
  });

  it('accepts only one or two cards per message and requires the field',()=>{
    expect(parseDailyDigestSettingsInput({...valid,cardsPerMessage:1}).cardsPerMessage).toBe(1);
    expect(parseDailyDigestSettingsInput({...valid,cardsPerMessage:2}).cardsPerMessage).toBe(2);
    expect(()=>parseDailyDigestSettingsInput({...valid,cardsPerMessage:0})).toThrow();
    expect(()=>parseDailyDigestSettingsInput({...valid,cardsPerMessage:3})).toThrow();
    const missing={...valid} as Partial<typeof valid>;
    delete missing.cardsPerMessage;
    expect(()=>parseDailyDigestSettingsInput(missing)).toThrow();
  });
});
