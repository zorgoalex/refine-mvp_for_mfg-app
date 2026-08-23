import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { retainPrivacySafePerformanceArtifacts } from '../../tests/helpers/performanceArtifactPrivacy';

describe('performance artifact privacy cleanup', () => {
    let fixtureDir = '';

    afterEach(async () => {
        if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
        fixtureDir = '';
    });

    it('removes raw HAR, safe HAR and trace after forbidden HAR material', async () => {
        const paths = await createPaths();
        await writeFile(paths.rawHarPath, JSON.stringify({
            log: {
                entries: [{
                    request: {
                        url: 'http://localhost/api/v1/orders/42',
                        headers: [{ name: 'authorization', value: 'Bearer forbidden' }],
                    },
                    response: { headers: [] },
                }],
            },
        }));
        await writeFile(paths.safeHarPath, 'stale-safe-artifact');
        await writeTrace(paths.tracePath, 'clean trace');

        await expect(retainPrivacySafePerformanceArtifacts(paths)).rejects.toThrow(
            'forbidden identity or credential material',
        );
        await expectAllCaptureFilesAbsent(paths);
    });

    it('removes sanitized HAR and trace after forbidden trace material', async () => {
        const paths = await createPaths();
        await writeFile(paths.rawHarPath, JSON.stringify({ log: { entries: [] } }));
        await writeTrace(paths.tracePath, 'authorization: Bearer forbidden');

        await expect(retainPrivacySafePerformanceArtifacts(paths)).rejects.toThrow(
            'forbidden material',
        );
        await expectAllCaptureFilesAbsent(paths);
    });

    async function createPaths() {
        fixtureDir = await mkdtemp(join(tmpdir(), 'erp-performance-artifact-'));
        return {
            rawHarPath: join(fixtureDir, 'network.har.raw'),
            safeHarPath: join(fixtureDir, 'network.har'),
            tracePath: join(fixtureDir, 'trace.zip'),
        };
    }
});

async function writeTrace(path: string, content: string): Promise<void> {
    const archive = new JSZip();
    archive.file('trace.trace', content);
    await writeFile(path, await archive.generateAsync({ type: 'nodebuffer' }));
}

async function expectAllCaptureFilesAbsent(paths: Record<string, string>): Promise<void> {
    for (const path of Object.values(paths)) {
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
}
