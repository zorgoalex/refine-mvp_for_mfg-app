export interface LabelTextFields {
  orderName?: string;
  detailNumber?: number;
  width?: number;
  height?: number;
  date?: string;
  material?: string;
}

export function extractLabelFields(lines: string[]): LabelTextFields {
  const text = lines.join(' ');
  const result: LabelTextFields = {};

  // Extract detail number (Поз/По3/etc.)
  // Pattern: По[зЗ3z] followed by 0-3 non-word chars, then digits
  const posMatch = text.match(/По[зЗ3z]\W{0,3}(\d+)/i);
  if (posMatch) {
    result.detailNumber = parseInt(posMatch[1], 10);
  }

  // Extract order name (from Заказ№: to Поз/Бир marker or end of text)
  // Stop at По[зЗ3z], Бир, or end of string
  const orderMatch = text.match(/Заказ№:\s*(.+?)(?:По[зЗ3z]|Бир|$)/i);
  if (orderMatch) {
    result.orderName = orderMatch[1].trim();
  }

  // Extract date (dd.mm.yyyy format)
  const dateMatch = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (dateMatch) {
    result.date = dateMatch[0];
  }

  // Extract material (МДФ with mm size)
  const materialMatch = text.match(/МДФ\s*(\d+)\s*мм/i);
  if (materialMatch) {
    result.material = `МДФ ${materialMatch[1]}мм`;
  }

  // Extract dimensions (width x height)
  // - 2-4 digit numbers
  // - Separated by x/X/х/Х/×/% (one or two chars)
  // - No letters/digits glued to numbers (word boundaries via lookbehind/lookahead)
  const sizePattern = /(?<![\dА-Яа-яA-Za-z])(\d{2,4})[\s]*[xхXХ×%]{1,2}[\s]*(\d{2,4})(?![\dА-Яа-яA-Za-z])/g;
  const sizeMatch = sizePattern.exec(text);
  if (sizeMatch) {
    result.width = parseInt(sizeMatch[1], 10);
    result.height = parseInt(sizeMatch[2], 10);
  }

  return result;
}
