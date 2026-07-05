/**
 * Sniff an image's MIME type from its magic bytes. Client-supplied `mimetype`/`Content-Type`
 * headers are NOT trusted for the scan-resolve-image upload (Codex R2/R3 requirement) —
 * a caller could send arbitrary bytes with a spoofed `image/png` header. This inspects the
 * actual buffer content instead.
 *
 * Supported signatures:
 * - PNG: 89 50 4E 47 ("\x89PNG")
 * - JPEG: FF D8 FF (SOI marker + first segment marker prefix)
 * - BMP: 42 4D ("BM")
 *
 * Returns null for anything else (including empty/too-short buffers) — callers must treat
 * null as "reject the upload" (415 UNSUPPORTED_IMAGE_TYPE).
 */
export function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/bmp' | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}
