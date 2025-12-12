// Excel Import Button - Entry point for import functionality

import React, { useState, useCallback } from 'react';
import { Button, message } from 'antd';
import { FileExcelOutlined } from '@ant-design/icons';
import { ExcelImportModal } from './ExcelImportModal';

interface ExcelImportButtonProps {
  onSuccess?: (count: number) => void;
}

export const ExcelImportButton: React.FC<ExcelImportButtonProps> = ({ onSuccess }) => {
  const [modalOpen, setModalOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  const handleSuccess = useCallback((count: number) => {
    onSuccess?.(count);
    setModalOpen(false);
  }, [onSuccess]);

  return (
    <>
      <Button
        icon={<FileExcelOutlined />}
        onClick={handleOpen}
      >
        Импорт из Excel
      </Button>

      <ExcelImportModal
        open={modalOpen}
        onClose={handleClose}
        onSuccess={handleSuccess}
      />
    </>
  );
};
