// Print of a sheet built off the page (calendar, MDF board): the sheet goes into a body-level container, a root
// class lets that container's CSS hide everything else on paper, `@page` sets the paper, then the browser print.
// Every deferred step is cancellable and the page is always restored — on afterprint, after print() returns,
// when cancelled, or when print() throws.

export interface IsolatedPrintOptions {
  /** class of the body-level container (its CSS: hidden on screen, the only thing on paper while printing) */
  containerClass: string;
  /** class put on <html> while printing */
  rootClass: string;
  /** e.g. `@page { size: A4 landscape; margin: 8mm; }` */
  pageRule: string;
  sheets: readonly HTMLElement[];
  /** scales a sheet once it is laid out (called off screen, before printing) */
  fit?: (sheet: HTMLElement) => void;
  onDone: () => void;
  /** injectable for tests */
  print?: () => void;
}

export function runIsolatedPrint(options: IsolatedPrintOptions): () => void {
  const { containerClass, rootClass, pageRule, sheets, fit, onDone } = options;
  const print = options.print ?? (() => window.print());
  const root = document.documentElement;
  const container = document.createElement('div');
  container.className = containerClass;
  const style = document.createElement('style');
  style.textContent = pageRule;
  const frames: number[] = [];
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    frames.forEach((frame) => cancelAnimationFrame(frame));
    window.removeEventListener('afterprint', finish);
    root.classList.remove(rootClass);
    container.remove();
    style.remove();
    onDone();
  };

  try {
    sheets.forEach((sheet) => container.append(sheet));
    // laid out off screen once, so each sheet can be scaled by its real width (on screen the container is hidden)
    container.style.cssText = 'display:block;position:absolute;left:-100000px;top:0;visibility:hidden';
    document.body.append(container);
    if (fit) sheets.forEach(fit);
    container.style.cssText = '';
    document.head.append(style);
    root.classList.add(rootClass);
    window.addEventListener('afterprint', finish);
  } catch (error) {
    finish();
    throw error;
  }

  frames.push(requestAnimationFrame(() => {
    if (finished) return;
    frames.push(requestAnimationFrame(() => {
      if (finished) return;
      try {
        print();
      } finally {
        finish();
      }
    }));
  }));
  return finish;
}

/** A print snapshot remembers the settings it was built with; only a snapshot of the current settings is printed. */
export interface PrintSnapshot<P extends string> {
  key: string;
  paper: P;
  sheets: HTMLElement[];
}

export function currentPrintSnapshot<P extends string>(snapshot: PrintSnapshot<P> | null, key: string): PrintSnapshot<P> | null {
  return snapshot && snapshot.key === key && snapshot.sheets.length > 0 ? snapshot : null;
}
