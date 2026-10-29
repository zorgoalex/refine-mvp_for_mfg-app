// «NewLine»: «Печать» of the MDF board — columns to print (ticks), sheet format, preview; then the browser print
// (where «Сохранить как PDF» is too). The printed sheet itself is the board's own print view, mounted while printing.
import React, { useEffect } from 'react';
import { Button, Checkbox, Modal, Space } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { Segmented } from '../../../ui/Segmented';
import { chosenMdfPrintColumns, mdfPrint, useMdfPrintState, type MdfPrintPaper } from './mdfPrintStore';
import './mdfPrint.css';

const PRINTING_CLASS = 'wb-mdf-printing';

export interface MdfPrintColumnOption {
  key: string;
  title: string;
  total: number;
  color: string;
}

interface MdfPrintDialogProps {
  columns: readonly MdfPrintColumnOption[];
  /** the board's print view of these columns (preview) */
  renderPreview: (columnKeys: readonly string[]) => React.ReactNode;
}

export const MdfPrintDialog: React.FC<MdfPrintDialogProps> = ({ columns, renderPreview }) => {
  const { open, printing, paper, columnKeys } = useMdfPrintState();
  const chosen = chosenMdfPrintColumns(columns, columnKeys);
  const chosenKeys = chosen.map((column) => column.key);

  useEffect(() => {
    if (!printing) return undefined;
    const root = document.documentElement;
    root.classList.add(PRINTING_CLASS);
    const style = document.createElement('style');
    style.textContent = `@page cnc-board { size: ${paper} landscape; margin: 8mm; }`;
    document.head.appendChild(style);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.classList.remove(PRINTING_CLASS);
      style.remove();
      mdfPrint.setPrinting(false);
    };
    window.addEventListener('afterprint', finish);
    // two frames: the sheet of the chosen columns is laid out before the print snapshot
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      window.print();
      finish();
    }));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', finish);
      root.classList.remove(PRINTING_CLASS);
      style.remove();
    };
  }, [paper, printing]);

  const toggle = (key: string, checked: boolean) => {
    const next = checked ? [...chosenKeys, key] : chosenKeys.filter((item) => item !== key);
    mdfPrint.setColumnKeys(columns.map((column) => column.key).filter((item) => next.includes(item)));
  };

  return (
    <Modal
      open={open}
      title="Печать МДФ-доски"
      width={1040}
      className="wb-mdf-print-dialog"
      onCancel={() => mdfPrint.close()}
      destroyOnClose
      footer={(
        <Space>
          <Button onClick={() => mdfPrint.close()}>Отмена</Button>
          <Button type="primary" icon={<PrinterOutlined />} disabled={chosen.length === 0} onClick={() => mdfPrint.setPrinting(true)}>
            Печать
          </Button>
        </Space>
      )}
    >
      <div className="wb-mdf-print-dialog__options">
        <span>Формат листа</span>
        <Segmented
          value={paper}
          options={[
            { label: 'A4 альбом', value: 'A4' },
            { label: 'A3 альбом', value: 'A3' },
          ]}
          onChange={(value) => mdfPrint.setPaper(value as MdfPrintPaper)}
        />
        <Button size="small" type="link" onClick={() => mdfPrint.setColumnKeys(null)}>Все колонки</Button>
        <Button size="small" type="link" onClick={() => mdfPrint.setColumnKeys([])}>Снять все</Button>
      </div>
      <div className="wb-mdf-print-dialog__columns" role="group" aria-label="Колонки для печати">
        {columns.map((column) => (
          <Checkbox
            key={column.key}
            checked={chosenKeys.includes(column.key)}
            onChange={(event) => toggle(column.key, event.target.checked)}
            style={{ ['--wb-mdf-column' as string]: column.color }}
          >
            {column.title} <b>{column.total}</b>
          </Checkbox>
        ))}
      </div>
      <p className="wb-mdf-print-dialog__hint">
        Печатаются карточки, как они сейчас на доске (дата, период, поиск, ручные перемещения). В окне печати браузера
        можно выбрать «Сохранить как PDF».
      </p>
      <div className="wb-mdf-print-preview" data-paper={paper}>
        {chosen.length > 0 ? renderPreview(chosenKeys) : <span className="wb-mdf-print-preview__empty">Выберите колонки</span>}
      </div>
    </Modal>
  );
};
