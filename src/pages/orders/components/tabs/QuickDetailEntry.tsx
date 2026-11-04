// «NewLine», мокап 05: строка быстрого ввода деталей под «Параметрами деталей по умолчанию».
import React, { useState } from 'react';
import { Button, Input, message } from 'antd';
import { parseQuickDetailEntry, type QuickDetailRow } from '../../quickDetailEntry';

interface QuickDetailEntryProps {
  /** добавляет строки с текущими параметрами по умолчанию; false — не добавлено (открытая строка не заполнена) */
  onAdd: (rows: QuickDetailRow[]) => Promise<boolean>;
}

export const QuickDetailEntry: React.FC<QuickDetailEntryProps> = ({ onAdd }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const { rows, invalid } = parseQuickDetailEntry(text);
    if (invalid.length > 0) {
      message.error(`Не понял: ${invalid.slice(0, 3).join('; ')}${invalid.length > 3 ? '…' : ''}. Формат — 716×396×2`);
      return;
    }
    if (rows.length === 0) return;
    setBusy(true);
    try {
      if (!(await onAdd(rows))) return;
      setText('');
      const pieces = rows.reduce((sum, row) => sum + row.quantity, 0);
      message.success(rows.length === 1 ? 'Деталь добавлена' : `Добавлено деталей: ${rows.length} (${pieces} шт.)`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-quick-details">
      <label htmlFor="wb-quick-details-input">Быстрый ввод</label>
      <Input.TextArea
        id="wb-quick-details-input"
        aria-label="Быстрый ввод деталей: высота × ширина × количество"
        value={text}
        autoSize={{ minRows: 1, maxRows: 4 }}
        placeholder="716×396×2 — Enter; несколько — по строке или через «;»"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter добавляет, Shift+Enter — новая строка
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <Button onClick={() => void submit()} loading={busy} disabled={!text.trim()}>Добавить</Button>
    </div>
  );
};
