// Вытаскивает первый встроенный растр (DIB) из EMF и упаковывает его в BMP,
// который умеет читать zxing. Покрывает бирки, экспортированные Базисом в
// .emf с растровым содержимым. Векторный EMF без растровых записей → null.
// Формат записей: [iType u32 LE][nSize u32 LE][данные] ([MS-EMF] 2.3).
const EMR_HEADER = 1;
const RASTER_RECORDS = new Set([
  76, // EMR_BITBLT
  77, // EMR_STRETCHBLT
  80, // EMR_SETDIBITSTODEVICE
  81, // EMR_STRETCHDIBITS
]);

// Смещения полей offBmiSrc/cbBmiSrc/offBitsSrc/cbBitsSrc от начала записи.
const DIB_FIELD_OFFSETS: Record<number, number> = {
  81: 48, // EMR_STRETCHDIBITS
  80: 48, // EMR_SETDIBITSTODEVICE (совпадает по layout до этих полей)
  76: 84, // EMR_BITBLT
  77: 84, // EMR_STRETCHBLT
};

export function extractBmpFromEmf(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 88) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== EMR_HEADER) return null;

  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const type = dv.getUint32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    if (size < 8 || pos + size > bytes.length) return null; // битая запись

    if (RASTER_RECORDS.has(type)) {
      const base = DIB_FIELD_OFFSETS[type];
      if (pos + base + 16 <= bytes.length) {
        const offBmi = dv.getUint32(pos + base, true);
        const cbBmi = dv.getUint32(pos + base + 4, true);
        const offBits = dv.getUint32(pos + base + 8, true);
        const cbBits = dv.getUint32(pos + base + 12, true);
        if (
          cbBmi >= 40 &&
          cbBits > 0 &&
          pos + offBmi + cbBmi <= bytes.length &&
          pos + offBits + cbBits <= bytes.length
        ) {
          const bmi = bytes.slice(pos + offBmi, pos + offBmi + cbBmi);
          const bits = bytes.slice(pos + offBits, pos + offBits + cbBits);
          // BITMAPFILEHEADER (14) + BITMAPINFO + пиксели.
          const out = new Uint8Array(14 + bmi.length + bits.length);
          const odv = new DataView(out.buffer);
          out[0] = 0x42; // B
          out[1] = 0x4d; // M
          odv.setUint32(2, out.length, true);
          odv.setUint32(10, 14 + bmi.length, true); // смещение пикселей
          out.set(bmi, 14);
          out.set(bits, 14 + bmi.length);
          return out;
        }
      }
    }
    pos += size;
  }
  return null;
}
