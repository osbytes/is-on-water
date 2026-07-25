#!/usr/bin/env node
/**
 * Check upstream OSM water-polygons for updates (HydroLAKES v1.0 is static).
 * If updated, rebuild FlatGeobuf and exit 0 with updated=true.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } =
    require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'layers.json');
const OSM_URL =
    process.env.OSM_WATER_URL ||
    'https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

function setOutput(name, value) {
    console.log(`${name}=${value}`);
    if (!GITHUB_OUTPUT) return;
    writeFileSync(GITHUB_OUTPUT, `${name}=${value}\n`, { flag: 'a' });
}

function loadRegistry() {
    if (!existsSync(REGISTRY_PATH)) return null;
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function headSourceMeta(url) {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const result = spawnSync(bin, ['-sI', url], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`HEAD ${url} failed: ${result.stderr || result.status}`);
    }
    const headers = result.stdout || '';
    const lm = /^last-modified:\s*(.+)$/im.exec(headers);
    const et = /^etag:\s*(.+)$/im.exec(headers);
    return {
        lastModified: lm ? new Date(lm[1].trim()).toISOString() : null,
        etag: et ? et[1].trim() : null,
    };
}

function rebuild() {
    const zipPath = path.join(
        DATA_DIR,
        '_osm',
        'water-polygons-split-4326.zip'
    );
    if (existsSync(zipPath)) rmSync(zipPath);

    const result = spawnSync(
        'node',
        [path.join(__dirname, 'build-waterbodies-fgb.js')],
        { cwd: ROOT, stdio: 'inherit', env: { ...process.env } }
    );
    if (result.status !== 0) {
        throw new Error('Dataset rebuild failed');
    }
}

function main() {
    mkdirSync(DATA_DIR, { recursive: true });
    const registry = loadRegistry();
    const remote = headSourceMeta(OSM_URL);
    console.log(`Remote OSM Last-Modified: ${remote.lastModified}`);
    console.log(`Remote OSM ETag: ${remote.etag}`);

    const pinned = registry?.sources?.find(
        (s) => s.id === 'osm-water-polygons'
    );
    console.log(
        `Pinned OSM Last-Modified: ${
            pinned ? pinned.sourceLastModified : '(none)'
        }`
    );

    const sameEtag =
        pinned &&
        remote.etag &&
        pinned.sourceEtag &&
        pinned.sourceEtag === remote.etag;
    const sameModified =
        pinned &&
        remote.lastModified &&
        pinned.sourceLastModified === remote.lastModified;

    if (registry && (sameEtag || sameModified)) {
        console.log('Dataset is up to date.');
        setOutput('updated', 'false');
        setOutput('source_version', remote.lastModified || remote.etag || '');
        return;
    }

    console.log('OSM water-polygons update detected; rebuilding…');
    rebuild();

    const next = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    const nextOsm = next.sources?.find((s) => s.id === 'osm-water-polygons');
    const featureCount = (next.artifacts ?? [])
        .filter((a) => a.delivery === 'bundled')
        .reduce((sum, a) => sum + (a.featureCount ?? 0), 0);

    setOutput('updated', 'true');
    setOutput(
        'source_version',
        nextOsm?.sourceLastModified || nextOsm?.sourceEtag || next.generatedAt
    );
    setOutput(
        'previous_version',
        pinned ? pinned.sourceLastModified || pinned.sourceEtag || '' : ''
    );
    setOutput('feature_count', String(featureCount));
}

main();
