export function buildLabelPrintDocument(svgPages: readonly string[], title = 'Печать бирок'): string {
  const pages = svgPages
    .map((svg, index) => `
      <section class="label-print-page" aria-label="Бирка ${index + 1}">
        <div class="label-print-page__inner">${svg}</div>
      </section>
    `)
    .join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      margin: 0;
      size: auto;
    }

    html,
    body {
      margin: 0;
      min-height: 100%;
      background: #fff;
      color: #111;
    }

    .label-print-page {
      align-items: center;
      background: #fff;
      break-after: page;
      box-sizing: border-box;
      display: flex;
      justify-content: center;
      min-height: 100vh;
      page-break-after: always;
      page-break-inside: avoid;
      padding: 0;
    }

    .label-print-page:last-child {
      break-after: auto;
      page-break-after: auto;
    }

    .label-print-page__inner {
      line-height: 0;
    }

    .label-print-page svg {
      display: block;
      height: auto;
      max-height: 100vh;
      max-width: 100vw;
      width: auto;
    }

    @media screen {
      body {
        background: #f5f5f5;
      }

      .label-print-page {
        margin: 16px auto;
        min-height: auto;
        padding: 24px;
        width: fit-content;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16);
      }
    }
  </style>
</head>
<body>
  ${pages}
</body>
</html>`;
}

export function printLabelSvgPages(svgPages: readonly string[], title = 'Печать бирок'): boolean {
  if (typeof document === 'undefined' || svgPages.length === 0) {
    return false;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', title);
  iframe.style.border = '0';
  iframe.style.height = '0';
  iframe.style.opacity = '0';
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';

  document.body.appendChild(iframe);

  const frameWindow = iframe.contentWindow;
  const frameDocument = iframe.contentDocument ?? frameWindow?.document ?? null;
  if (!frameWindow || !frameDocument) {
    iframe.remove();
    return false;
  }

  let cleanupTimer: number | undefined;
  const cleanup = () => {
    if (cleanupTimer !== undefined) {
      window.clearTimeout(cleanupTimer);
    }
    iframe.remove();
  };

  frameWindow.addEventListener('afterprint', cleanup, { once: true });
  cleanupTimer = window.setTimeout(cleanup, 120_000);

  frameDocument.open();
  frameDocument.write(buildLabelPrintDocument(svgPages, title));
  frameDocument.close();

  window.setTimeout(() => {
    try {
      frameWindow.focus();
      frameWindow.print();
    } catch {
      cleanup();
    }
  }, 100);

  return true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
