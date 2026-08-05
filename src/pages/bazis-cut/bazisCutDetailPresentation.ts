export interface BazisCutQrCodeSource {
  sourceBazisProjectName?: string | null;
  position?: string | null;
}

export interface BazisCutPositionSource {
  sourceBazisOrderNo?: string | null;
  sourceBazisProjectName?: string | null;
  position?: string | null;
}

export function buildBazisCutCardPosition(source: BazisCutPositionSource): string {
  const prefix = clean(source.sourceBazisOrderNo) || clean(source.sourceBazisProjectName);
  return `${prefix}${clean(source.position)}`;
}

export function buildBazisCutQrCode(source: BazisCutQrCodeSource): string {
  return `${clean(source.sourceBazisProjectName)}${clean(source.position)}`;
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

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}
