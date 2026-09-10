import { useId, type ReactNode } from 'react';
import { Button, Tooltip } from 'antd';
import { LeftOutlined, RightOutlined, SettingOutlined, UnorderedListOutlined } from '@ant-design/icons';

/** Keep the body mounted: collapsing must not discard field drafts or list scroll. */
export function CadSidePanel({ side, title, open, onToggle, children }: {
  side: 'left' | 'right'; title: string; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  const id = useId();
  const icon = open
    ? side === 'left' ? <LeftOutlined /> : <RightOutlined />
    : side === 'left' ? <UnorderedListOutlined /> : <SettingOutlined />;
  return <aside className={`cad-side-panel cad-side-panel-${side}${open ? ' is-open' : ''}`} aria-label={title}>
    <Tooltip title={`${open ? 'Свернуть' : 'Раскрыть'}: ${title}`} placement={side === 'left' ? 'right' : 'left'}>
      <Button type="text" className="cad-side-panel-toggle" icon={icon} aria-label={title}
        aria-expanded={open} aria-controls={id} onClick={onToggle}>{open ? title : null}</Button>
    </Tooltip>
    <div id={id} hidden={!open} className={`cad-side-panel-body ${side === 'left' ? 'cad-parts-panel' : 'cad-inspector'}`}>
      {children}
    </div>
  </aside>;
}
