export interface BitmapImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function createWhiteBitmap(width: number, height: number): BitmapImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255;
    rgba[i + 1] = 255;
    rgba[i + 2] = 255;
    rgba[i + 3] = 255;
  }
  return { width, height, rgba };
}

export function writeBmp(image: BitmapImage): Buffer {
  const rowStride = Math.ceil((image.width * 3) / 4) * 4;
  const pixelSize = rowStride * image.height;
  const fileSize = 54 + pixelSize;
  const buffer = Buffer.alloc(fileSize);

  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(fileSize, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(image.width, 18);
  buffer.writeInt32LE(image.height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelSize, 34);

  for (let y = 0; y < image.height; y += 1) {
    const srcY = image.height - 1 - y;
    const destRow = 54 + y * rowStride;
    for (let x = 0; x < image.width; x += 1) {
      const src = (srcY * image.width + x) * 4;
      const dest = destRow + x * 3;
      buffer[dest] = image.rgba[src + 2] ?? 255;
      buffer[dest + 1] = image.rgba[src + 1] ?? 255;
      buffer[dest + 2] = image.rgba[src] ?? 255;
    }
  }

  return buffer;
}
