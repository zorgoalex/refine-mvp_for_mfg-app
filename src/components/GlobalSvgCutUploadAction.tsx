import { Tooltip } from '../ui/tooltipDelay';
import React, { Suspense, lazy, useState } from 'react';
import { Button, Dropdown, type DropdownProps, type TooltipProps } from 'antd';
import { EllipsisOutlined, FileAddOutlined } from '@ant-design/icons';
import { featureFlags } from '../config/featureFlags';
import { can } from '../utils/permissions';

const CutSvgUploadModal = lazy(async () => ({
  default: (await import('../pages/cut/CutSvgUploadModal')).CutSvgUploadModal,
}));

export interface GlobalSvgCutUploadActionProps {
  className?: string;
  placement?: DropdownProps['placement'];
  tooltipPlacement?: TooltipProps['placement'];
}

export const GlobalSvgCutUploadAction: React.FC<GlobalSvgCutUploadActionProps> = ({ className, placement = 'bottomRight', tooltipPlacement = 'bottom' }) => {
  const [svgUploadOpen, setSvgUploadOpen] = useState(false);

  if (!featureFlags.useBackendCut || !can('cut.manage')) return null;

  return (
    <>
      <Tooltip placement={tooltipPlacement} title="Действия приложения">
        <span style={{ display: 'inline-flex' }}>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'svg-cut-upload',
                  icon: <FileAddOutlined />,
                  label: 'Загрузка SVG раскроя',
                },
              ],
              onClick: ({ key }) => {
                if (key === 'svg-cut-upload') setSvgUploadOpen(true);
              },
            }}
            placement={placement}
            trigger={['click']}
          >
            <Button aria-label="Действия приложения" className={className} icon={<EllipsisOutlined />} type="text" />
          </Dropdown>
        </span>
      </Tooltip>
      {svgUploadOpen ? (
        <Suspense fallback={null}>
          <CutSvgUploadModal open={svgUploadOpen} onClose={() => setSvgUploadOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
};
