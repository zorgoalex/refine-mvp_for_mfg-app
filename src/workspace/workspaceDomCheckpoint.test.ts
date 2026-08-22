import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureWorkspaceDomCheckpoint,
  restoreWorkspaceDomCheckpoint,
} from './workspaceDomCheckpoint';

class FakeElement {
  id = '';
  dataset: Record<string, string | undefined> = {};
  protected attributes = new Map<string, string>();
  children: FakeElement[] = [];

  contains(candidate: unknown): boolean {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelectorAll(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
  }
}

class FakeInput extends FakeElement {
  value = '';
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  focus = vi.fn();
  dispatchEvent = vi.fn();

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

describe('workspace DOM checkpoint behavior', () => {
  let activeElement: FakeElement | null;
  let roots: FakeElement[];
  let animationFrames: Array<() => void>;
  let scrollY: number;

  beforeEach(() => {
    activeElement = null;
    roots = [];
    animationFrames = [];
    scrollY = 0;
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('HTMLInputElement', FakeInput);
    vi.stubGlobal('HTMLTextAreaElement', FakeInput);
    vi.stubGlobal('document', {
      get activeElement() {
        return activeElement;
      },
      querySelectorAll: () => roots,
    });
    vi.stubGlobal('window', {
      get scrollY() {
        return scrollY;
      },
      scrollTo: vi.fn(({ top }: { top: number }) => {
        scrollY = top;
      }),
      requestAnimationFrame: (callback: () => void) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures focus/raw cursor only inside the exact workspace root', () => {
    const rootA = workspaceRoot('order-a');
    const rootB = workspaceRoot('order-b');
    const input = workspaceInput('detail-height', '12,', 2, 3);
    rootA.children.push(input);
    roots = [rootA, rootB];
    activeElement = input;
    scrollY = 480;

    expect(captureWorkspaceDomCheckpoint('order-a')).toEqual({
      scrollY: 480,
      focus: {
        kind: 'workspace-field',
        value: 'detail-height',
        rawValue: '12,',
        selectionStart: 2,
        selectionEnd: 3,
      },
    });
    expect(captureWorkspaceDomCheckpoint('order-b')).toEqual({
      scrollY: 480,
      focus: null,
    });
    expect(captureWorkspaceDomCheckpoint('missing')).toEqual({
      scrollY: 480,
      focus: null,
    });
  });

  it('restores raw input/cursor without dispatching events or validating', () => {
    const root = workspaceRoot('order-a');
    const input = workspaceInput('detail-height', '', 0, 0);
    root.children.push(input);
    roots = [root];

    restoreWorkspaceDomCheckpoint('order-a', {
      scrollY: 720,
      focus: {
        kind: 'workspace-field',
        value: 'detail-height',
        rawValue: '12,',
        selectionStart: 2,
        selectionEnd: 3,
      },
    });
    while (animationFrames.length > 0) animationFrames.shift()?.();

    expect(scrollY).toBe(720);
    expect(input.value).toBe('12,');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(3);
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(input.dispatchEvent).not.toHaveBeenCalled();
  });
});

function workspaceRoot(workspaceKey: string): FakeElement {
  const root = new FakeElement();
  root.dataset.workspaceKey = workspaceKey;
  return root;
}

function workspaceInput(
  field: string,
  value: string,
  selectionStart: number,
  selectionEnd: number,
): FakeInput {
  const input = new FakeInput();
  input.setAttribute('data-workspace-field', field);
  input.value = value;
  input.selectionStart = selectionStart;
  input.selectionEnd = selectionEnd;
  return input;
}
