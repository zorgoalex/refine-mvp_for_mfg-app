import React from 'react';
import { Layout } from 'antd';
import { EvolutionHeaderUtilities } from './EvolutionHeaderUtilities';

export interface EvolutionHeaderProps {
  onOpenSider?: () => void;
}

export const EvolutionHeader: React.FC<EvolutionHeaderProps> = ({ onOpenSider }) => {
  return (
    <Layout.Header className="evolution-header">
      <EvolutionHeaderUtilities onOpenSider={onOpenSider} />
    </Layout.Header>
  );
};
