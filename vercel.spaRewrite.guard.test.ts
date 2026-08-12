import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(resolve(__dirname, 'vercel.json'), 'utf8')) as {
  rewrites: Array<{ source: string; destination: string }>;
};

describe('Vercel SPA rewrite', () => {
  it('keeps SPA deep-link fallback for app routes', () => {
    const spaRewrite = config.rewrites.at(-1);
    expect(spaRewrite?.destination).toBe('/index.html');

    const sourcePattern = new RegExp(`^${spaRewrite?.source}$`);
    expect(sourcePattern.test('/orders/show/123')).toBe(true);
    expect(sourcePattern.test('/configuration')).toBe(true);
  });

  it('does not rewrite missing hashed assets to index.html', () => {
    const spaRewrite = config.rewrites.at(-1);
    const sourcePattern = new RegExp(`^${spaRewrite?.source}$`);

    expect(sourcePattern.test('/assets/edit-b4c054b6.js')).toBe(false);
    expect(sourcePattern.test('/assets/App-b504b33c.js')).toBe(false);
  });
});
