// Button to trigger Excel Import Modal

import React, { useState, useCallback } from 'react';
import { Button, Tooltip } from 'antd';
import { FileExcelOutlined } from '@ant-design/icons';
import { ExcelImportModal } from './ExcelImportModal';

interface ExcelImportButtonProps {
  disabled?: boolean;
}

export const ExcelImportButton: React.FC<ExcelImportButtonProps> = ({ disabled }) => {
  const [modalOpen, setModalOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  return (
    <>
      <Tooltip title="Импорт деталей из Excel-файла">
        <Button
          icon={<FileExcelOutlined />}
          onClick={handleOpen}
          disabled={disabled}
        >
          Импорт из Excel
        </Button>
      </Tooltip>

      <ExcelImportModal open={modalOpen} onClose={handleClose} />
    </>
  );
};
