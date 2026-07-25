import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { LayerArtifact } from './layers';
import { formatSelection } from './layers';
import { dataDir, readFgbBytes, type FgbSource } from './waterbodies-index';

export type AcquiredArtifact = {
    source: FgbSource;
    /** Bytes held in memory. Zero for range-queried artifacts. */
    residentBytes: number;
};

const sha256 = (buf: Buffer | Uint8Array): string =>
    createHash('sha256').update(buf).digest('hex');

export const defaultCacheDir = path.join(dataDir, '_layer-cache');

const cacheFileFor = (artifact: LayerArtifact, cacheDir: string): string =>
    path.join(cacheDir, `${artifact.feature}-${artifact.precision}.fgb.gz`);

const verifyChecksum = (filePath: string, expected: string, label: string) => {
    const actual = sha256(readFileSync(filePath));
    if (actual !== expected) {
        throw new Error(
            `Checksum mismatch for ${label}: expected ${expected}, got ${actual}`
        );
    }
};

const downloadArtifact = async (
    artifact: LayerArtifact,
    destPath: string,
    label: string,
    signal?: AbortSignal
): Promise<void> => {
    mkdirSync(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;

    const res = await fetch(artifact.url as string, { signal });
    if (!res.ok || !res.body) {
        throw new Error(
            `Download failed for ${label}: HTTP ${res.status} ${res.statusText}`
        );
    }

    try {
        await pipeline(
            Readable.fromWeb(res.body as unknown as NodeReadableStream),
            createWriteStream(partPath)
        );
        if (artifact.sha256) {
            verifyChecksum(partPath, artifact.sha256, label);
        }
        const { rename } = await import('node:fs/promises');
        await rename(partPath, destPath);
    } catch (err) {
        await rm(partPath, { force: true });
        throw err;
    }
};

/**
 * Make an artifact queryable, honouring its delivery mode.
 *
 * `bundled` reads from the data directory, `download` fetches once into the
 * cache directory and verifies its checksum, and `range` hands back the URL so
 * queries hit it with HTTP range requests instead of holding it in memory.
 */
export const acquireArtifact = async (
    artifact: LayerArtifact,
    options: { cacheDir?: string; signal?: AbortSignal } = {}
): Promise<AcquiredArtifact> => {
    const label = formatSelection(artifact);
    const cacheDir = options.cacheDir ?? defaultCacheDir;

    if (artifact.delivery === 'range') {
        if (!artifact.url) {
            throw new Error(`Artifact ${label} is range-delivered but has no url`);
        }
        return { source: artifact.url, residentBytes: 0 };
    }

    if (artifact.delivery === 'bundled') {
        if (!artifact.file) {
            throw new Error(`Artifact ${label} is bundled but has no file`);
        }
        const bytes = readFgbBytes(path.join(dataDir, artifact.file));
        return { source: bytes, residentBytes: bytes.byteLength };
    }

    if (!artifact.url) {
        throw new Error(`Artifact ${label} is download-delivered but has no url`);
    }

    const cached = cacheFileFor(artifact, cacheDir);
    if (existsSync(cached)) {
        if (artifact.sha256) {
            // A corrupt or stale cache entry should be replaced, not fatal.
            try {
                verifyChecksum(cached, artifact.sha256, label);
            } catch {
                await rm(cached, { force: true });
            }
        }
    }

    if (!existsSync(cached)) {
        await downloadArtifact(artifact, cached, label, options.signal);
    }

    const bytes = readFgbBytes(cached);
    return { source: bytes, residentBytes: bytes.byteLength };
};
