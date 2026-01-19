// Dropdown button with Excel, PDF and VLM image import options

import React, { useState, useCallback, Suspense, lazy } from 'react';
import { Dropdown, Button, Tooltip, Spin } from 'antd';
import type { MenuProps } from 'antd';
import { ImportOutlined, FileExcelOutlined, FilePdfOutlined, CameraOutlined, DownOutlined } from '@ant-design/icons';

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
}

export const ImportDropdownButton: React.FC<ImportDropdownButtonProps> = ({ disabled }) => {
  const [excelModalOpen, setExcelModalOpen] = useState(false);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [vlmModalOpen, setVlmModalOpen] = useState(false);

  const handleExcelOpen = useCallback(() => {
    setExcelModalOpen(true);
  }, []);

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
          <Button icon={<ImportOutlined />} disabled={disabled}>
            Импорт <DownOutlined style={{ fontSize: 10 }} />
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
