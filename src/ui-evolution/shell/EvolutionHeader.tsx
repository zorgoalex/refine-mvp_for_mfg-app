import React from 'react';
import { Layout } from 'antd';
import { EvolutionHeaderUtilities } from './EvolutionHeaderUtilities';

export interface EvolutionHeaderProps {
  onOpenSider?: () => void;
  operational?: boolean;
  tablet?: boolean;
}

export const EvolutionHeader: React.FC<EvolutionHeaderProps> = ({
  onOpenSider,
  operational = false,
  tablet = false,
}) => {
  return (
    <Layout.Header className="evolution-header">
      <EvolutionHeaderUtilities onOpenSider={onOpenSider} operational={operational} tablet={tablet} />
    </Layout.Header>
  );
};
