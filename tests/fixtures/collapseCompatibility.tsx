import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Collapse } from 'antd';

const configurations = [
  'cut-results-history-collapse', 'cut-page-modern__details', 'cnc-packet-card__sheet',
];

function Example({ className, legacy }: { className: string; legacy: boolean }) {
  const [active, setActive] = useState<string[]>([]);
  const [changes, setChanges] = useState(0);
  const [parentClicks, setParentClicks] = useState(0);
  const [collapseClicks, setCollapseClicks] = useState(0);
  const controlled = className === 'cnc-packet-card__sheet';
  return <section data-testid={`${className}-${legacy ? 'before' : 'after'}`} onClick={() => setParentClicks(n => n + 1)}>
    <Collapse className={className} {...(legacy ? { size: 'small' } : {})}
      {...(controlled ? { ghost: true, activeKey: active } : { defaultActiveKey: [] })}
      {...(controlled && legacy ? { onClick: (event: React.MouseEvent) => { setCollapseClicks(n => n + 1); event.stopPropagation(); } } : {})}
      onChange={keys => { setActive(typeof keys === 'string' ? [keys] : keys); setChanges(n => n + 1); }}>
      <Collapse.Panel header="Тест панель" key="test"><div>Тест детали</div></Collapse.Panel>
    </Collapse>
    <output data-testid="changes">{changes}</output>
    <output data-testid="parent-clicks">{parentClicks}</output>
    <output data-testid="collapse-clicks">{collapseClicks}</output>
  </section>;
}

createRoot(document.getElementById('root')!).render(<>
  {configurations.flatMap(className => [true, false].map(legacy =>
    <Example key={`${className}-${legacy}`} className={className} legacy={legacy} />))}
</>);
