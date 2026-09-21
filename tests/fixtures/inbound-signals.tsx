import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { authSession } from '../../src/api/authSession';
import { inboundSignalsApi as api, type SignalConfiguration } from '../../src/api/inboundSignalsApi';
import { InboundSignalsList } from '../../src/pages/inbound-signals/list';
import { MessageProcessingConfig } from '../../src/pages/configuration/components/MessageProcessingConfig';

const params = new URLSearchParams(location.search);
const permissions = ['message_signals.view', ...(params.has('manager') ? [] : ['message_signals.resolve','message_signals.technical','message_signals.manage_config'])];
authSession.setUser({ id:'1',username:'E2E-Тест',role:'admin',permissions } as Parameters<typeof authSession.setUser>[0]);
const message = { channel:'whatsapp',source_name:'E2E-Тест цех',sender:'E2E-Тест участник',message_text:'Заказ 1254 готов к выдаче',sent_at:new Date().toISOString(),received_at:new Date().toISOString() };
let state = 'needs_review', version=1, fail=false;
let configuration: SignalConfiguration = { version:1,sources:[{ code:'shop',name:'E2E-Тест цех',channel:'whatsapp',connection:'erp',chatId:'123@g.us',enabled:true }],
  signals:[{ code:'ready',name:'Заказ готов' }],resolvers:[{ code:'order',name:'Номер заказа',target:'order_id',prefixes:['заказ'],format:'digits' }],
  rules:[{ code:'ready',name:'Готовность',sourceCodes:['shop'],signalCode:'ready',resolverCode:'order',keywords:['готов'],exclusions:['не готов'],matchMode:'phrase',enabled:true,priority:100 }] };
api.list = async () => { if (fail) throw new Error('E2E-Тест: сервер временно недоступен'); return { items:[{ ...message,id:'1',message_id:'1',source_code:'shop',signal_code:'ready',signal_name:'Заказ готов',state,reason_code:null,order_id:null,order_name:null,version }],total:1,attention:1,completed:0,relayEnabled:false,automationEnabled:true }; };
api.detail = async () => ({ id:'1',version,signalCode:'ready',signalName:'Заказ готов',orderId:null,state,message,
  steps:[{ occurred_at:new Date().toISOString(),event_code:'signal_detected',actor_user_id:null,details:{} }],actions:[],
  ...(params.has('manager') ? {} : { technical:{ requestId:'e2e-request',configVersion:1,ruleCodes:['ready'],attemptCount:0 } }) });
api.orders=async () => [{ id:'1254',name:'E2E-Тест заказ' }];
api.preview=async () => ({ version,previewHash:'a'.repeat(64),automationEnabled:true,order:{ order_id:'1254',order_name:'E2E-Тест заказ' },applied:[{ id:1,name:'Готов к выдаче',actionType:'change_order_status',targetStatusId:6 }],skipped:[] });
api.command=async (_id,action) => { state=action==='dismiss' ? 'dismissed':'pending'; version++; return {}; };
api.configuration=async () => configuration;
api.saveConfiguration=async data => { if (!data.sources?.length || !data.signals?.length || !data.resolvers?.length || !data.rules?.length) throw new Error('Потеря вкладки при сохранении'); configuration={ ...data,version:data.version+1 }; return configuration; };
api.test=async () => [{ ruleCode:'ready',signalCode:'ready',references:['1254'] }];
createRoot(document.getElementById('root')!).render(<ConfigProvider locale={ruRU}><main style={{ padding:24 }}>
  <button onClick={() => { fail=true; }}>E2E-Тест ошибка сети</button>
  {params.has('config') ? <MessageProcessingConfig /> : <InboundSignalsList />}
</main></ConfigProvider>);
