import { Tooltip } from '../../../../ui/tooltipDelay';
// Dropdown button with Excel, PDF and VLM image import options

import React, { useState, useRef, useCallback, Suspense, lazy } from 'react';
import { Dropdown, Button, Spin, message } from 'antd';
import type { MenuProps } from 'antd';
import { ImportOutlined, FileExcelOutlined, FilePdfOutlined, CameraOutlined, DownOutlined } from '@ant-design/icons';
import { OrderToolbarLabel } from '../OrderDetailsToolbar';
import { useKeepAlive } from '../../../../components/workspace/KeepAliveContext';
import { useWorkspaceCheckpointAdapter } from '../../../../workspace/workspaceCheckpointReact';
import { readWorkspaceCheckpointAdapterState } from '../../../../workspace/workspaceCheckpointRegistry';

const ExcelImportModal = lazy(async () => ({
  default: (await import('./ExcelImportModal')).ExcelImportModal,
}));

const PdfImportModal = lazy(async () => ({
  default: (await import('./PdfImportModal')).PdfImportModal,
}));

const VlmImportModal = lazy(async () => ({
  default: (await import('./VlmImportModal')).VlmImportModal,
}));

interface ImportDropdownButtonProps {
  disabled?: boolean;
  beforeExcelImport?: () => Promise<boolean>;
}

export const ImportDropdownButton: React.FC<ImportDropdownButtonProps> = ({ disabled, beforeExcelImport }) => {
  const excelPreparing = useRef(false);
  const { tabKey } = useKeepAlive();
  const workspaceKey = tabKey || '/orders/create';
  const restored = readWorkspaceCheckpointAdapterState(workspaceKey, 'order-import-surfaces');
  const [excelModalOpen, setExcelModalOpen] = useState(() => restored?.excelOpen === true);
  const [pdfModalOpen, setPdfModalOpen] = useState(() => restored?.pdfOpen === true);
  const [vlmModalOpen, setVlmModalOpen] = useState(() => restored?.vlmOpen === true);

  useWorkspaceCheckpointAdapter(workspaceKey, 'order-import-surfaces', {
    capture: () => ({
      excelOpen: excelModalOpen,
      pdfOpen: pdfModalOpen,
      vlmOpen: vlmModalOpen,
    }),
  });

  const handleExcelOpen = useCallback(async () => {
    if (excelPreparing.current) return;
    excelPreparing.current = true;
    try {
      if (beforeExcelImport && !await beforeExcelImport()) return;
      setExcelModalOpen(true);
    } catch {
      message.error('Не удалось завершить редактирование детали. Повторите открытие импорта.');
    } finally {
      excelPreparing.current = false;
    }
  }, [beforeExcelImport]);

  const handleExcelClose = useCallback(() => {
    setExcelModalOpen(false);
  }, []);

  const handlePdfOpen = useCallback(() => {
    setPdfModalOpen(true);
  }, []);

  const handlePdfClose = useCallback(() => {
    setPdfModalOpen(false);
  }, []);

  const handleVlmOpen = useCallback(() => {
    setVlmModalOpen(true);
  }, []);

  const handleVlmClose = useCallback(() => {
    setVlmModalOpen(false);
  }, []);

  const menuItems: MenuProps['items'] = [
    {
      key: 'excel',
      icon: <FileExcelOutlined style={{ color: '#217346' }} />,
      label: 'Импорт из Excel',
      onClick: handleExcelOpen,
    },
    {
      key: 'pdf',
      icon: <FilePdfOutlined style={{ color: '#f5222d' }} />,
      label: 'Импорт из PDF Базис',
      onClick: handlePdfOpen,
    },
    {
      key: 'vlm',
      icon: <CameraOutlined style={{ color: '#1890ff' }} />,
      label: 'Импорт из фото',
      onClick: handleVlmOpen,
    },
  ];

  return (
    <>
      <Tooltip title="Импорт деталей из файла">
        <Dropdown menu={{ items: menuItems }} trigger={['click']} disabled={disabled}>
          <Button
            icon={<ImportOutlined />}
            disabled={disabled}
            aria-label="Импорт деталей из файла"
          >
            <OrderToolbarLabel>Импорт</OrderToolbarLabel> <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      </Tooltip>

      {excelModalOpen && (
        <Suspense fallback={<Spin />}>
          <ExcelImportModal open={excelModalOpen} onClose={handleExcelClose} />
        </Suspense>
      )}

      {pdfModalOpen && (
        <Suspense fallback={<Spin />}>
          <PdfImportModal open={pdfModalOpen} onClose={handlePdfClose} />
        </Suspense>
      )}

      {vlmModalOpen && (
        <Suspense fallback={<Spin />}>
          <VlmImportModal open={vlmModalOpen} onClose={handleVlmClose} />
        </Suspense>
      )}
    </>
  );
};
