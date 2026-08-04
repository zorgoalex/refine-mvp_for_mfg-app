export interface BazisCutQrCodeSource {
  sourceBazisProjectName?: string | null;
  position?: string | null;
}

export function buildBazisCutQrCode(source: BazisCutQrCodeSource): string {
  return `${clean(source.sourceBazisProjectName)}${clean(source.position)}`;
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
