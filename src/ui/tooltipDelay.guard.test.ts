import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const uiDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = fileURLToPath(new URL('../..', import.meta.url));
const wrapperPath = join(uiDir, 'tooltipDelay.tsx');
const wrapperSource = readFileSync(wrapperPath, 'utf8');
const appSource = readFileSync(join(srcDir, 'App.tsx'), 'utf8');
const viteConfig = readFileSync(join(repoDir, 'vite.config.ts'), 'utf8');
const vitestConfig = readFileSync(join(repoDir, 'vitest.config.ts'), 'utf8');

const TARGET_ANTD_EXPORTS = new Set(['Tooltip', 'Popover', 'Table']);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const filePath = join(dir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) return listSourceFiles(filePath);
    if (/\.(ts|tsx)$/.test(entry)) return [filePath];
    return [];
  });
}

function valueImportsDelayedComponents(source: string): boolean {
  const importPattern = /import\s+(type\s+)?\{([^;{}]*)\}\s+from\s+['"]antd['"]/g;
  return Array.from(source.matchAll(importPattern)).some((match) => {
    if (match[1]) return false;
    const specifiers = match[2].split(',').map((specifier) => specifier.trim()).filter(Boolean);
    return specifiers.some((specifier) => {
      if (specifier.startsWith('type ')) return false;
      const importedName = specifier.split(/\s+as\s+/)[0]?.trim();
      return TARGET_ANTD_EXPORTS.has(importedName);
    });
  });
}

describe('delayed tooltip defaults', () => {
  it('keeps antd imports direct and does not alias the whole package', () => {
    expect(viteConfig).not.toContain('find: /^antd$/');
    expect(vitestConfig).not.toContain('find: /^antd$/');
    expect(appSource).toContain("from 'antd/locale/ru_RU'");
    expect(appSource).not.toContain('tooltip={{ mouseEnterDelay');
    expect(appSource).not.toContain('table={{ showSorterTooltip');
  });

  it('applies a minimum hover delay to regular, popover, and table sorter tooltips', () => {
    expect(wrapperSource).toContain('APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS = 0.45');
    expect(wrapperSource).toContain('Math.max(delay ?? APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS');
    expect(wrapperSource).toContain('React.forwardRef<unknown, AntdTooltipProps>');
    expect(wrapperSource).toContain('React.forwardRef<unknown, AntdPopoverProps>');
    expect(wrapperSource).toContain('showSorterTooltip={withDelayedSorterTooltip(showSorterTooltip)}');
    expect(wrapperSource).toContain('Object.assign(DelayedTable, AntdTable)');
  });

  it('routes app Tooltip, Popover, and Table values through the delayed wrapper', () => {
    const offenders = listSourceFiles(srcDir)
      .filter((filePath) => filePath !== wrapperPath)
      .filter((filePath) => valueImportsDelayedComponents(readFileSync(filePath, 'utf8')))
      .map((filePath) => relative(repoDir, filePath).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });
});
