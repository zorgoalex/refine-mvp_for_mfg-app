import React, { useEffect, useState } from 'react';
import { Alert, Spin, Typography } from 'antd';

const CUT_PDF_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type CutPdfjsModule = typeof import('pdfjs-dist');

type CutPdfPagePreview = {
  pageNumber: number;
  url: string;
};

type CutPdfPreviewProps = {
  blob: Blob | null;
  loading: boolean;
};

let cutPdfjsPromise: Promise<CutPdfjsModule> | null = null;
let cutPdfjsWorkerConfigured = false;

const previewFrameStyle: React.CSSProperties = {
  width: '100%',
  height: 'min(72vh, 760px)',
  minHeight: 420,
  overflow: 'auto',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  borderRadius: 6,
  background: '#f5f5f5',
  padding: 12,
};

const previewPageStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  maxWidth: 920,
  height: 'auto',
  margin: '0 auto 16px',
  boxShadow: '0 1px 6px rgba(0, 0, 0, 0.16)',
  background: '#fff',
};

async function loadCutPdfjs(): Promise<CutPdfjsModule> {
  if (!cutPdfjsPromise) {
    cutPdfjsPromise = import('pdfjs-dist');
  }
  const pdfjsLib = await cutPdfjsPromise;
  if (!cutPdfjsWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = CUT_PDF_WORKER_SRC;
    cutPdfjsWorkerConfigured = true;
  }
  return pdfjsLib;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Не удалось подготовить страницу PDF'));
      }
    }, 'image/png');
  });
}

function revokeCutPdfPagePreviewUrls(previews: CutPdfPagePreview[]) {
  previews.forEach((preview) => URL.revokeObjectURL(preview.url));
}

async function renderCutPdfPagePreviews(blob: Blob): Promise<CutPdfPagePreview[]> {
  const pdfjsLib = await loadCutPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  const previews: CutPdfPagePreview[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) throw new Error('Canvas недоступен для предпросмотра PDF');

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      await page.render({
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
    revokeCutPdfPagePreviewUrls(previews);
    throw error;
  } finally {
    await pdf.destroy();
  }

  return previews;
}

export const CutPdfPreview: React.FC<CutPdfPreviewProps> = ({ blob, loading }) => {
  const [pages, setPages] = useState<CutPdfPagePreview[]>([]);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let currentPages: CutPdfPagePreview[] = [];

    setPages([]);
    setError(null);

    if (!blob || loading) {
      setRendering(false);
      return () => {
        cancelled = true;
      };
    }

    setRendering(true);
    void renderCutPdfPagePreviews(blob)
      .then((nextPages) => {
        if (cancelled) {
          revokeCutPdfPagePreviewUrls(nextPages);
          return;
        }
        currentPages = nextPages;
        setPages(nextPages);
      })
      .catch((renderError: unknown) => {
        if (cancelled) return;
        setError(renderError instanceof Error ? renderError.message : 'Не удалось показать PDF в браузере');
      })
      .finally(() => {
        if (!cancelled) {
          setRendering(false);
        }
      });

    return () => {
      cancelled = true;
      revokeCutPdfPagePreviewUrls(currentPages);
    };
  }, [blob, loading]);

  if (loading || rendering) {
    return (
      <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin tip="Готовим PDF" />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" showIcon message="Не удалось показать PDF" description={error} />;
  }

  if (!blob) {
    return <Alert type="warning" showIcon message="PDF не загружен" />;
  }

  if (pages.length === 0) {
    return <Alert type="warning" showIcon message="В PDF нет страниц" />;
  }

  return (
    <div data-testid="cut-pdf-preview-pages" style={previewFrameStyle}>
      {pages.map((page) => (
        <div key={page.pageNumber}>
          <Typography.Text type="secondary">Страница {page.pageNumber}</Typography.Text>
          <img
            data-testid={`cut-pdf-preview-page-${page.pageNumber}`}
            alt={`Страница PDF ${page.pageNumber}`}
            src={page.url}
            style={previewPageStyle}
          />
        </div>
      ))}
    </div>
  );
};
