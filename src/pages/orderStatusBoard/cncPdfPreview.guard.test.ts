import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const previewModule = readFileSync(
  'src/pages/orderStatusBoard/cncPdfPreview.ts',
  'utf8',
);

describe('CNC PDF preview lazy module guard', () => {
  it('preserves multi-page rendering, retina scaling, cleanup and worker configuration', () => {
    expect(previewModule).toContain("import('pdfjs-dist')");
    expect(previewModule).toContain("'pdfjs-dist/build/pdf.worker.min.mjs'");
    expect(previewModule).toContain('pdfjs.GlobalWorkerOptions.workerSrc = CNC_PDF_WORKER_SRC');
    expect(previewModule).toContain('pageNumber <= pdf.numPages');
    expect(previewModule).toContain('window.devicePixelRatio || 1');
    expect(previewModule).toContain('canvas,');
    expect(previewModule).toContain('URL.createObjectURL(imageBlob)');
    expect(previewModule).toContain('URL.revokeObjectURL(preview.url)');
    expect(previewModule).toContain('await pdf.destroy()');
  });
});
