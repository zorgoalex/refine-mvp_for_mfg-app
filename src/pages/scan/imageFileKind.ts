// Сниффинг типа изображения по байтам (расширению не доверяем: Базис/Windows
// отдают .emf, внутри которого может лежать обычный BMP-растр).
// EMF: запись EMR_HEADER (type=1) + сигнатура " EMF" (0x464D4520 LE) на
// смещении 40 ([MS-EMF] 2.2.9 Header Object).
export const EMF_SIGNATURE_OFFSET = 40;

export type ImageKind = 'bmp' | 'emf' | 'other';

export function detectImageKind(bytes: Uint8Array): ImageKind {
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'; // "BM"
  if (
    bytes.length >= EMF_SIGNATURE_OFFSET + 4 &&
    bytes[EMF_SIGNATURE_OFFSET] === 0x20 &&
    bytes[EMF_SIGNATURE_OFFSET + 1] === 0x45 && // E
    bytes[EMF_SIGNATURE_OFFSET + 2] === 0x4d && // M
    bytes[EMF_SIGNATURE_OFFSET + 3] === 0x46 // F
  ) {
    return 'emf';
  }
  return 'other';
}
