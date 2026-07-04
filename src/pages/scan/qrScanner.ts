// Ленивая обёртка над zxing-wasm: камера запрашивается ТОЛЬКО при старте
// сканера (не при загрузке приложения). Возвращает stop().
export async function startQrScanner(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
): Promise<() => void> {
  const { readBarcodes } = await import('zxing-wasm/reader');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let stopped = false;
  let lastText = '';

  const tick = async () => {
    if (stopped) return;
    if (ctx && video.videoWidth > 0) {
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve));
        if (blob) {
          const results = await readBarcodes(blob, { formats: ['QRCode'], maxNumberOfSymbols: 1 });
          const text = results[0]?.text?.trim();
          if (text && text !== lastText) {
            lastText = text;
            onResult(text);
          }
        }
      } catch {
        /* нечитаемый кадр — продолжаем */
      }
    }
    if (!stopped) setTimeout(tick, 250);
  };
  void tick();

  return () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

// Декод QR из файла-изображения (фото из галереи/камеры). Камера не нужна:
// zxing принимает Blob напрямую. null = QR на фото не найден/не распознан.
export async function decodeQrFromFile(file: Blob): Promise<string | null> {
  const { readBarcodes } = await import('zxing-wasm/reader');
  try {
    const results = await readBarcodes(file, { formats: ['QRCode'], maxNumberOfSymbols: 1 });
    return results[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}
