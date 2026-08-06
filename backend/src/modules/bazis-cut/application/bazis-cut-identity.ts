export interface BazisCutIdentitySource {
  sourceBazisProjectName?: string | null;
  sourceBazisOrderNo?: string | null;
  sourceOrderName?: string | null;
  sourceBazisProductName?: string | null;
  position?: string | null;
}

export function buildBazisCutQrCode(source: BazisCutIdentitySource): string {
  const document = clean(source.sourceBazisProjectName)
    || clean(source.sourceBazisOrderNo)
    || clean(source.sourceOrderName);
  return `${document}${clean(source.sourceBazisProductName)}.${clean(source.position)}`;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}
