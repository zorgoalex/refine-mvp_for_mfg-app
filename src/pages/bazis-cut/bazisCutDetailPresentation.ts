export interface BazisCutQrCodeSource {
  sourceBazisOrderNo?: string | null;
  sourceBazisProductName?: string | null;
  position?: string | null;
}

export function buildBazisCutQrCode(source: BazisCutQrCodeSource): string {
  const prefix = `${clean(source.sourceBazisOrderNo)}${clean(source.sourceBazisProductName)}`;
  const position = clean(source.position);
  if (!prefix) return position;
  return position ? `${prefix}.${position}` : prefix;
}

export function summarizeBazisCutDetails(details: readonly { quantity: number }[]): {
  positionCount: number;
  quantity: number;
} {
  return {
    positionCount: details.length,
    quantity: details.reduce((sum, detail) => sum + detail.quantity, 0),
  };
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}
