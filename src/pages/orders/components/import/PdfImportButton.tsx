// Button to trigger PDF Import Modal

import React, { useState, useCallback, Suspense, lazy } from 'react';
import { Button, Tooltip, Spin } from 'antd';
import { FilePdfOutlined } from '@ant-design/icons';

const PdfImportModal = lazy(async () => ({
  default: (await import('./PdfImportModal')).PdfImportModal,
}));

interface PdfImportButtonProps {
  disabled?: boolean;
}

export const PdfImportButton: React.FC<PdfImportButtonProps> = ({ disabled }) => {
  const [modalOpen, setModalOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  return (
    <>
      <Tooltip title="Импорт деталей из PDF-файла">
        <Button
          icon={<FilePdfOutlined />}
          onClick={handleOpen}
          disabled={disabled}
        >
          Импорт из PDF
        </Button>
      </Tooltip>

      {modalOpen && (
        <Suspense fallback={<Spin />}>
          <PdfImportModal open={modalOpen} onClose={handleClose} />
        </Suspense>
      )}
    </>
  );
};
