// Button to trigger Excel Import Modal

import React, { useState, useCallback, Suspense, lazy } from 'react';
import { Button, Tooltip, Spin } from 'antd';
import { FileExcelOutlined } from '@ant-design/icons';

const ExcelImportModal = lazy(async () => ({
  default: (await import('./ExcelImportModal')).ExcelImportModal,
}));

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

      {modalOpen && (
        <Suspense fallback={<Spin />}>
          <ExcelImportModal open={modalOpen} onClose={handleClose} />
        </Suspense>
      )}
    </>
  );
};
