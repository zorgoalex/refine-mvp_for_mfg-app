// «NewLine»: «Печать» of the MDF board — columns to print (ticks), sheet format, preview; then the browser print
// (where «Сохранить как PDF» is too). The sheet is a copy of the board itself in the chosen card mode: while this
// dialog is open the board draws every card (see `mdfPrintAll` in the board), the copy is taken from it.
import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal, Space } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { Segmented } from '../../../ui/Segmented';
import { chosenMdfPrintColumns, mdfPrint, useMdfPrintState, type MdfPrintPaper } from './mdfPrintStore';
import { buildMdfPrintSheet, fitMdfPrintSheet } from './mdfPrintSheet';
import { currentPrintSnapshot, runIsolatedPrint, type PrintSnapshot } from '../../../ui/isolatedPrint';
import './mdfPrint.css';

const PRINTING_CLASS = 'wb-mdf-printing';
/** the board draws its held-back cards after the dialog opens; the copy is taken once they are there */
const CARDS_SETTLE_MS = 400;

export interface MdfPrintColumnOption {
  key: string;
  title: string;
  total: number;
  color: string;
}

interface MdfPrintDialogProps {
  columns: readonly MdfPrintColumnOption[];
  printDate: string;
  /** «Стандарт», «Скрин», «Средний», «Компактный» — the card mode on screen, printed as it is */
  modeLabel: string;
  getBoard: () => HTMLElement | null;
}

const afterCardsDrawn = (run: () => void): (() => void) => {
  let timer = 0;
  const frame = requestAnimationFrame(() => {
    timer = window.setTimeout(run, CARDS_SETTLE_MS);
  });
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
};

export const MdfPrintDialog: React.FC<MdfPrintDialogProps> = ({ columns, printDate, modeLabel, getBoard }) => {
  const { open, printing, paper, columnKeys } = useMdfPrintState();
  const chosen = chosenMdfPrintColumns(columns, columnKeys);
  const chosenKeys = chosen.map((column) => column.key);
  const chosenKey = chosenKeys.join('|');
  // the settings a preview snapshot belongs to: a change makes the shown snapshot stale until it is rebuilt
  const settingsKey = `${paper}#${chosenKey}#${modeLabel}`;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<PrintSnapshot<MdfPrintPaper> | null>(null);
  const [previewReady, setPreviewReady] = useState(false);

  const sheetFor = () => {
    const board = getBoard();
    if (!board || chosenKeys.length === 0) return null;
    return buildMdfPrintSheet({
      board, columnKeys: chosenKeys, paper, title: 'МДФ-работы', printDate, modeLabel,
    });
  };

  // preview: the copy taken after the board has drawn all its cards, in a scaled-down sheet
  useEffect(() => {
    setPreviewReady(false);
    snapshotRef.current = null;
    if (!open) return undefined;
    let retry = 0;
    const draw = () => {
      const holder = previewRef.current;
      if (!holder) {
        retry = window.setTimeout(draw, 50);
        return;
      }
      holder.replaceChildren();
      const sheet = sheetFor();
      snapshotRef.current = sheet
        ? { key: settingsKey, paper, sheets: [sheet.cloneNode(true) as HTMLElement] }
        : null;
      if (sheet) {
        holder.append(sheet);
        fitMdfPrintSheet(sheet);
      }
      setPreviewReady(Boolean(sheet));
    };
    const cancel = afterCardsDrawn(draw);
    return () => {
      cancel();
      window.clearTimeout(retry);
    };
  }, [open, paper, chosenKey, modeLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  // the sheet printed is the snapshot shown in the preview (the board keeps refreshing while the dialog is open)
  useEffect(() => {
    if (!printing) return undefined;
    const snapshot = currentPrintSnapshot(snapshotRef.current, settingsKey);
    if (!snapshot) {
      mdfPrint.setPrinting(false);
      return undefined;
    }
    return runIsolatedPrint({
      containerClass: 'wb-mdf-print-live',
      rootClass: PRINTING_CLASS,
      pageRule: `@page { size: ${snapshot.paper} landscape; margin: 8mm; }`,
      sheets: snapshot.sheets.map((sheet) => sheet.cloneNode(true) as HTMLElement),
      fit: fitMdfPrintSheet,
      onDone: () => mdfPrint.setPrinting(false),
    });
  }, [printing]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            disabled={chosen.length === 0 || !previewReady}
            loading={printing}
            onClick={() => mdfPrint.setPrinting(true)}
          >
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
        Печатается доска как на экране{modeLabel ? <> — вид «{modeLabel}»</> : null}: те же карточки, дата, период,
        поиск и ручные перемещения; колонки ужимаются по ширине листа. Другой вид карточек выбирается на доске.
        В окне печати браузера можно выбрать «Сохранить как PDF».
      </p>
      <div className="wb-mdf-print-preview" data-paper={paper}>
        {chosen.length === 0 ? <span className="wb-mdf-print-preview__empty">Выберите колонки</span> : null}
        {chosen.length > 0 && !previewReady ? <span className="wb-mdf-print-preview__empty">Готовлю предпросмотр…</span> : null}
        <div ref={previewRef} className="wb-mdf-print-preview__sheet" hidden={chosen.length === 0} />
      </div>
    </Modal>
  );
};
