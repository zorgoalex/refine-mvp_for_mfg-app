import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const src = resolve(root, 'src');
const read = (file: string) => readFileSync(file, 'utf8');
const rel = (file: string) => relative(root, file).replaceAll('\\', '/');

/** Every import specifier of a module: static, side-effect and dynamic, in either quote style. */
function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The real dependency graph of the customer window, starting at the entry its HTML page loads. */
function graph(entry: string): { files: string[]; packages: string[]; unresolved: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(read(file))) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }
      if (specifier.endsWith('.css')) continue;
      const target = resolveImport(file, specifier);
      if (target) queue.push(target);
      else unresolved.push(`${rel(file)} → ${specifier}`);
    }
  }
  return { files: [...files].map(rel).sort(), packages: [...packages].sort(), unresolved };
}

const html = read(resolve(root, 'client-screen.html'));
const entry = resolve(src, 'pages/clientScreen/clientScreenMain.tsx');
const window = graph(entry);

describe('customer window isolation', () => {
  it('client-screen.html loads its own entry, and the build has it as a separate input', () => {
    expect(html).toContain('<script type="module" src="/src/pages/clientScreen/clientScreenMain.tsx"></script>');
    expect(html).not.toContain('/src/index.tsx');
    const vite = read(resolve(root, 'vite.config.ts'));
    expect(vite).toMatch(/input:\s*\{\s*main:\s*"index\.html",\s*clientScreen:\s*"client-screen\.html"\s*\}/);
  });

  it('the whole dependency graph of the customer window is its own folder plus the runtime-config reader', () => {
    expect(window.unresolved).toEqual([]);
    const outside = window.files.filter((file) => !file.startsWith('src/pages/clientScreen/'));
    // The runtime config is the one thing the window reads from the network: is the screen switched on.
    expect(outside).toEqual(['src/config/featureFlags.ts', 'src/config/runtimeConfig.ts']);
    expect(window.packages).toEqual(['react', 'react-dom/client', 'zod']);
    for (const file of ['src/pages/clientScreen/ClientScreenPage.tsx', 'src/pages/clientScreen/clientScreenViewerRuntime.ts', 'src/pages/clientScreen/clientScreenArbiter.ts']) {
      expect(window.files).toContain(file);
    }
  });

  it('nothing of the manager side or of the app is in that graph', () => {
    for (const file of ['clientScreenPresenter.ts', 'orderEditSnapshotSource.ts', 'buildClientScreenSnapshot.ts', 'clientScreenPublisherCore.ts']) {
      expect(window.files).not.toContain(`src/pages/clientScreen/${file}`);
    }
    for (const file of window.files) {
      const source = read(resolve(root, file));
      expect(source, file).not.toMatch(/httpClient|authSession|apiRoutes|orderFormStore|sessionStorage|XMLHttpRequest|EventSource|WebSocket/);
      // The only network call is the runtime-config fetch.
      if (file !== 'src/config/runtimeConfig.ts') expect(source, file).not.toMatch(/\bfetch\(/);
      // localStorage is touched in one place only, for the workstation record (comments may name it).
      if (file !== 'src/pages/clientScreen/clientScreenEnvironment.ts') expect(source, file).not.toMatch(/\blocalStorage\s*[.[]|\.localStorage\b/);
    }
  });

  it('the main application entry knows nothing about the customer window', () => {
    const main = graph(resolve(src, 'index.tsx'));
    expect(read(resolve(src, 'index.tsx'))).not.toMatch(/clientScreen/);
    expect(main.files).not.toContain('src/pages/clientScreen/clientScreenMain.tsx');
    expect(main.files).not.toContain('src/pages/clientScreen/mountClientScreen.tsx');
    expect(main.files).not.toContain('src/pages/clientScreen/ClientScreenPage.tsx');
  });
});
