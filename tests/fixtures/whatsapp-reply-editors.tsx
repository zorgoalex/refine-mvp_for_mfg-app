import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'antd';
import { TemplateEditor, RuleEditor } from '../../src/pages/configuration/components/WhatsAppConfigTabs';
import { whatsappApi } from '../../src/api/whatsappApi';
import type { WhatsAppRuleDto, WhatsAppTemplateDto } from '../../src/api/types/whatsappApi.types';
const template: WhatsAppTemplateDto = { id: 1, code: 'test_reply', name: 'Тест ответ', body: 'Заказ {order_number}. №{counter}', bodyMode: 'template', enabled: true, version: 1, createdAt: '', updatedAt: '' };
const rule: WhatsAppRuleDto = { id: 1, code: 'test_rule', name: 'Тест правило', matchMode: 'pattern_exact', replyMode: 'quote', keywords: ['Заказ {order_number:number} готов'], templateId: 1, templateName: template.name, priority: 100, enabled: true, version: 1 };
whatsappApi.preview = async body => (await fetch('/fixture-preview', { method: 'POST', body: JSON.stringify(body) })).json();
whatsappApi.updateTemplate = async (_id, body) => { await fetch('/fixture-template', { method: 'POST', body: JSON.stringify(body) }); return template; };
whatsappApi.updateRule = async (_id, body) => { await fetch('/fixture-rule', { method: 'POST', body: JSON.stringify(body) }); return rule; };
function App() {
  const [editing, setEditing] = useState<'template' | 'rule' | null>(null);
  return <><Button onClick={() => setEditing('template')}>Открыть ответ</Button><Button onClick={() => setEditing('rule')}>Открыть правило</Button>
    <TemplateEditor open={editing === 'template' ? template : null} onClose={() => setEditing(null)} onSaved={async () => {}} />
    <RuleEditor open={editing === 'rule' ? rule : null} templates={[template]} onClose={() => setEditing(null)} onSaved={async () => {}} />
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
