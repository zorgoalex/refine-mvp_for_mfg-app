import React from 'react';
import { Alert, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { cadApi } from '../../api/cadApi';
import { can } from '../../utils/permissions';
import { CadLegacyPage } from './CadLegacyPage';
import { CadEditorPage } from './CadEditorPage';

export function CadPage() {
  const allowed = can('cad.view') && can('orders.view');
  const capabilities = useQuery(['cad-capabilities'], cadApi.capabilities, { enabled: allowed, retry: false });
  if (!allowed) return <Alert type="warning" message="Нет доступа к CAD" />;
  if (capabilities.isLoading) return <Spin />;
  if (capabilities.isError) return <Alert type="error" message="CAD API недоступен" />;
  return capabilities.data?.enabled && capabilities.data.editorEnabled ? <CadEditorPage /> : <CadLegacyPage />;
}
