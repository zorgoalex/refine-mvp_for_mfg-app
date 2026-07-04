import { describe, expect, it } from 'vitest';
import { extractBmpFromEmf } from './emfRaster';
import { EMF_SIGNATURE_OFFSET } from './imageFileKind';

// Синтетический EMF: header-запись (type=1) + EMR_STRETCHDIBITS (type=81)
// с крошечным BITMAPINFOHEADER (40 байт) и 4 байтами пикселей.
function syntheticEmf(): Uint8Array {
  const header = new Uint8Array(88);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 1, true); // EMR_HEADER
  dv.setUint32(4, 88, true); // nSize
  header.set([0x20, 0x45, 0x4d, 0x46], EMF_SIGNATURE_OFFSET);

  const bmi = new Uint8Array(40);
  new DataView(bmi.buffer).setUint32(0, 40, true); // biSize
  new DataView(bmi.buffer).setInt32(4, 1, true); // width
  new DataView(bmi.buffer).setInt32(8, 1, true); // height
  const bits = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

  const recSize = 80 + bmi.length + bits.length;
  const rec = new Uint8Array(recSize);
  const rdv = new DataView(rec.buffer);
  rdv.setUint32(0, 81, true); // EMR_STRETCHDIBITS
  rdv.setUint32(4, recSize, true);
  rdv.setUint32(48, 80, true); // offBmiSrc (от начала записи)
  rdv.setUint32(52, bmi.length, true); // cbBmiSrc
  rdv.setUint32(56, 80 + bmi.length, true); // offBitsSrc
  rdv.setUint32(60, bits.length, true); // cbBitsSrc
  rec.set(bmi, 80);
  rec.set(bits, 80 + bmi.length);

  const out = new Uint8Array(header.length + rec.length);
  out.set(header, 0);
  out.set(rec, header.length);
  return out;
}

describe('extractBmpFromEmf', () => {
  it('builds a BM file from the first embedded DIB', () => {
    const bmp = extractBmpFromEmf(syntheticEmf());
    expect(bmp).not.toBeNull();
    expect(bmp![0]).toBe(0x42); // B
    expect(bmp![1]).toBe(0x4d); // M
    // пиксели дошли до конца файла
    expect([...bmp!.slice(-4)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    // dataOffset = 14 + 40
    expect(new DataView(bmp!.buffer, bmp!.byteOffset).getUint32(10, true)).toBe(54);
  });

  it('returns null when no raster record present', () => {
    const onlyHeader = syntheticEmf().slice(0, 88);
    expect(extractBmpFromEmf(onlyHeader)).toBeNull();
    expect(extractBmpFromEmf(new Uint8Array(10))).toBeNull();
  });
});
