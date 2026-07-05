import { describe, expect, it } from 'vitest';
import { sniffImageMime } from './image-mime-sniffer';

describe('sniffImageMime', () => {
  it('detects PNG by magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMime(buf)).toBe('image/png');
  });

  it('detects JPEG by magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffImageMime(buf)).toBe('image/jpeg');
  });

  it('detects BMP by magic bytes', () => {
    const buf = Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
    expect(sniffImageMime(buf)).toBe('image/bmp');
  });

  it('returns null for unrecognized bytes', () => {
    expect(sniffImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  it('returns null for a spoofed extension with non-image content', () => {
    // Attacker sends a text/script payload but relies on a client-supplied
    // "image/png" Content-Type header — sniffing must ignore that header entirely
    // and only trust bytes.
    expect(sniffImageMime(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });

  it('returns null for too-short buffers', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('does not false-positive JPEG on PNG-only prefix bytes', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0x00]))).toBeNull();
  });
});
