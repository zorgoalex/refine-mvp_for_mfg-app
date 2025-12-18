// Button to trigger PDF Import Modal

import React, { useState, useCallback } from 'react';
import { Button, Tooltip } from 'antd';
import { FilePdfOutlined } from '@ant-design/icons';
import { PdfImportModal } from './PdfImportModal';

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

      <PdfImportModal open={modalOpen} onClose={handleClose} />
    </>
  );
};
