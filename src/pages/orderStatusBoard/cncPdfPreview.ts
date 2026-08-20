const CNC_PDF_WORKER_SRC = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

type CncPdfjsModule = typeof import('pdfjs-dist');

export interface CncPdfPagePreview {
  pageNumber: number;
  url: string;
}

let pdfjsPromise: Promise<CncPdfjsModule> | null = null;
let workerConfigured = false;

async function loadPdfjs(): Promise<CncPdfjsModule> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist');
  const pdfjs = await pdfjsPromise;
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = CNC_PDF_WORKER_SRC;
    workerConfigured = true;
  }
  return pdfjs;
}

export async function renderCncPdfPagePreviews(blob: Blob): Promise<CncPdfPagePreview[]> {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const previews: CncPdfPagePreview[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) {
        throw new Error('Canvas недоступен для предпросмотра PDF');
      }

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      await page.render({
        canvas,
        canvasContext,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        viewport,
      }).promise;

      const imageBlob = await canvasToPngBlob(canvas);
      previews.push({
        pageNumber,
        url: URL.createObjectURL(imageBlob),
      });
    }
  } catch (error) {
    previews.forEach((preview) => URL.revokeObjectURL(preview.url));
    throw error;
  } finally {
    await pdf.destroy();
  }

  return previews;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Не удалось подготовить изображение PDF'));
      }
    }, 'image/png');
  });
}
