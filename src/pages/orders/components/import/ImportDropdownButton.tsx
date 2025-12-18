// Dropdown button with Excel and PDF import options

import React, { useState, useCallback } from 'react';
import { Dropdown, Button, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { ImportOutlined, FileExcelOutlined, FilePdfOutlined, DownOutlined } from '@ant-design/icons';
import { ExcelImportModal } from './ExcelImportModal';
import { PdfImportModal } from './PdfImportModal';

interface ImportDropdownButtonProps {
  disabled?: boolean;
}

export const ImportDropdownButton: React.FC<ImportDropdownButtonProps> = ({ disabled }) => {
  const [excelModalOpen, setExcelModalOpen] = useState(false);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

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
      label: 'Импорт из PDF',
      onClick: handlePdfOpen,
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

      <ExcelImportModal open={excelModalOpen} onClose={handleExcelClose} />
      <PdfImportModal open={pdfModalOpen} onClose={handlePdfClose} />
    </>
  );
};
