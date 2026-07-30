import React from 'react';
import { Layout } from 'antd';
import { EvolutionHeaderUtilities } from './EvolutionHeaderUtilities';

export interface EvolutionHeaderProps {
  onOpenSider?: () => void;
  operational?: boolean;
}

export const EvolutionHeader: React.FC<EvolutionHeaderProps> = ({ onOpenSider, operational = false }) => {
  return (
    <Layout.Header className="evolution-header">
      <EvolutionHeaderUtilities onOpenSider={onOpenSider} operational={operational} />
    </Layout.Header>
  );
};
