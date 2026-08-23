import { readFile, unlink, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';

interface PerformanceCapturePaths {
    rawHarPath: string;
    safeHarPath: string;
    tracePath: string;
}

const FORBIDDEN_HAR_MATERIAL = /bearer\s|eyJ[a-zA-Z0-9_-]+\.|\/orders\/\d+|"(?:user|order|detail)[_-]?id"/i;
const FORBIDDEN_TRACE_MATERIAL = /authorization|bearer\s|eyJ[a-zA-Z0-9_-]+\.|synthetic-(?:artifact|actor)|refresh[_-]?token|\/orders\/\d+|"(?:user|order|detail)[_-]?id"/i;

export async function retainPrivacySafePerformanceArtifacts(
    paths: PerformanceCapturePaths,
): Promise<void> {
    try {
        await sanitizePerformanceHar(paths.rawHarPath, paths.safeHarPath);
        await assertPerformanceTracePrivacy(paths.tracePath);
    } catch (error) {
        await cleanupPerformanceCaptureArtifacts(paths);
        throw error;
    }
}

export async function cleanupPerformanceCaptureArtifacts(
    paths: PerformanceCapturePaths,
): Promise<void> {
    await Promise.allSettled([
        unlink(paths.rawHarPath),
        unlink(paths.safeHarPath),
        unlink(paths.tracePath),
    ]);
}

async function sanitizePerformanceHar(rawPath: string, safePath: string): Promise<void> {
    const har = JSON.parse(await readFile(rawPath, 'utf8')) as {
        log?: { entries?: Array<Record<string, any>> };
    };
    for (const entry of har.log?.entries ?? []) {
        if (entry.request) {
            entry.request.headers = [];
            entry.request.cookies = [];
            delete entry.request.postData;
            if (typeof entry.request.url === 'string') {
                entry.request.url = entry.request.url.replace(
                    /(\/assets\/[^/?]+)-[a-f0-9]{8,}(?=\.[^/?]+)/gi,
                    '$1-asset',
                );
            }
        }
        if (entry.response) {
            entry.response.headers = [];
            entry.response.cookies = [];
        }
    }
    const serialized = JSON.stringify(har, null, 2);
    if (FORBIDDEN_HAR_MATERIAL.test(serialized)) {
        throw new Error('Performance HAR contains forbidden identity or credential material');
    }
    await writeFile(safePath, serialized, 'utf8');
    await unlink(rawPath);
}

async function assertPerformanceTracePrivacy(tracePath: string): Promise<void> {
    const archive = await JSZip.loadAsync(await readFile(tracePath));
    for (const [name, file] of Object.entries(archive.files)) {
        if (file.dir) continue;
        const bytes = await file.async('uint8array');
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (FORBIDDEN_TRACE_MATERIAL.test(text)) {
            throw new Error(`Performance trace contains forbidden material in ${name}`);
        }
    }
}
