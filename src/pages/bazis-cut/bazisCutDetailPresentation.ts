export interface BazisCutQrCodeSource {
  sourceBazisProjectName?: string | null;
  sourceBazisOrderNo?: string | null;
  sourceOrderName?: string | null;
  sourceBazisProductName?: string | null;
  position?: string | null;
}

export interface BazisCutPositionSource {
  sourceBazisOrderNo?: string | null;
  sourceBazisProjectName?: string | null;
  position?: string | null;
}

export function buildBazisCutCardPosition(source: BazisCutPositionSource): string {
  return clean(source.position);
}

export function buildBazisCutQrCode(source: BazisCutQrCodeSource): string {
  const document = clean(source.sourceBazisProjectName)
    || clean(source.sourceBazisOrderNo)
    || clean(source.sourceOrderName);
  return `${document}${clean(source.sourceBazisProductName)}.${clean(source.position)}`;
}

export function summarizeBazisCutDetails(details: readonly {
  quantity: number;
  finishedLengthMm: number;
  finishedWidthMm: number;
}[]): {
  positionCount: number;
  quantity: number;
  totalAreaM2: number;
} {
  return {
    positionCount: details.length,
    quantity: details.reduce((sum, detail) => sum + detail.quantity, 0),
    totalAreaM2: details.reduce((sum, detail) => (
      sum + (detail.finishedLengthMm * detail.finishedWidthMm * detail.quantity) / 1_000_000
    ), 0),
  };
}

export function formatBazisCutAreaM2(value: number): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}
