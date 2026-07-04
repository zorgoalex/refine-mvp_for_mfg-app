import { describe, expect, it } from 'vitest';
import { detectImageKind, EMF_SIGNATURE_OFFSET } from './imageFileKind';

const bytes = (arr: number[]) => new Uint8Array(arr);

describe('detectImageKind', () => {
  it('detects BMP by BM header (включая .emf-файлы, которые на деле BMP)', () => {
    expect(detectImageKind(bytes([0x42, 0x4d, 0, 0, 0, 0, 0, 0]))).toBe('bmp');
  });

  it('detects real EMF by " EMF" signature at offset 40', () => {
    const b = new Uint8Array(48);
    b[0] = 0x01; // EMR_HEADER record type = 1
    b.set([0x20, 0x45, 0x4d, 0x46], EMF_SIGNATURE_OFFSET); // " EMF"
    expect(detectImageKind(b)).toBe('emf');
  });

  it('falls back to other for png/jpeg/garbage', () => {
    expect(detectImageKind(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe('other'); // PNG
    expect(detectImageKind(bytes([0xff, 0xd8, 0xff]))).toBe('other'); // JPEG
    expect(detectImageKind(new Uint8Array(4))).toBe('other');
  });
});
