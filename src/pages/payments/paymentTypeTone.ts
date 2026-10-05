/** Colour tone of a payment type mark in the NewLine payments list: cash, bank transfer, card/terminal. */
export type PaymentTypeTone = 'cash' | 'transfer' | 'card' | 'other';

export function paymentTypeTone(typeName: string): PaymentTypeTone {
  const name = typeName.trim().toLowerCase();
  if (!name) return 'other';
  if (/^нал|налич/.test(name)) return 'cash';
  if (/безнал|счёт|счет|перевод|банк(?!.*каспи)/.test(name) && !/каспи|kaspi/.test(name)) return 'transfer';
  if (/каспи|kaspi|карт|терминал|pos|qr/.test(name)) return 'card';
  return 'other';
}
