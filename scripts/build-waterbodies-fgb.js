#!/usr/bin/env node
/**
 * Build per-feature, per-precision waterbody artifacts plus data/layers.json.
 *
 * Sources:
 *   1. OSM coastline water polygons (oceans & seas)
 *      https://osmdata.openstreetmap.de/data/water-polygons.html  (ODbL)
 *   2. HydroLAKES v1.0 (inland lakes & reservoirs)
 *      https://www.hydrosheds.org/products/hydrolakes  (CC-BY 4.0)
 *
 * Each artifact is addressed as {feature}:{precision}. Precision controls both
 * the Douglas-Peucker tolerance and, for lakes, the minimum surface area, so a
 * higher precision means finer shorelines *and* more small water bodies.
 *
 *   BUILD_LAYERS=oceans:medium,lakes:medium   which artifacts to build
 *   BUNDLED_LAYERS=oceans:medium,lakes:medium which ones ship in the repo
 *   RELEASE_BASE_URL=...                      download URL prefix for the rest
 *
 * Requires Docker (GDAL with GEOS) unless USE_HOST_OGR=1.
 */
const { createHash } = require('node:crypto');
const {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    statSync,
    createWriteStream,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { gzipSync } = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LAYERS_DIR = path.join(DATA_DIR, 'layers');
const OSM_DIR = path.join(DATA_DIR, '_osm');
const LAKES_DIR = path.join(DATA_DIR, '_hydrolakes');
const REGISTRY_PATH = path.join(DATA_DIR, 'layers.json');

const OSM_ZIP_NAME = 'water-polygons-split-4326.zip';
const OSM_ZIP_PATH = path.join(OSM_DIR, OSM_ZIP_NAME);
const OSM_SHP_IN_ZIP =
    process.env.OSM_SHP_IN_ZIP ||
    'water-polygons-split-4326/water_polygons.shp';
const OSM_URL =
    process.env.OSM_WATER_URL ||
    `https://osmdata.openstreetmap.de/download/${OSM_ZIP_NAME}`;

const LAKES_ZIP_NAME = 'HydroLAKES_polys_v10_shp.zip';
const LAKES_ZIP_PATH = path.join(LAKES_DIR, LAKES_ZIP_NAME);
const LAKES_SHP_IN_ZIP =
    process.env.LAKES_SHP_IN_ZIP ||
    'HydroLAKES_polys_v10_shp/HydroLAKES_polys_v10.shp';
const LAKES_URL =
    process.env.HYDROLAKES_URL ||
    `https://data.hydrosheds.org/file/HydroLAKES/${LAKES_ZIP_NAME}`;

const GDAL_IMAGE =
    process.env.GDAL_IMAGE || 'ghcr.io/osgeo/gdal:alpine-normal-latest';
const GITHUB_SOFT_LIMIT = 95 * 1024 * 1024;

const DEFAULT_BUILD = 'oceans:medium,lakes:medium';
const DEFAULT_BUNDLED = 'oceans:medium,lakes:medium';
const RELEASE_BASE_URL =
    process.env.RELEASE_BASE_URL ||
    'https://github.com/osbytes/is-on-water/releases/download/data-v1';

/**
 * Simplify tolerances are in degrees; ~0.001° is ~111 m at the equator.
 * Lake thresholds are HydroLAKES `Lake_area` in km² (the source floor is 0.1).
 */
const FEATURES = {
    oceans: {
        defaultPrecision: 'medium',
        description: 'Oceans and seas, from the OSM coastline water polygons',
        source: 'osmdata.openstreetmap.de',
        sourceDataset: 'water-polygons-split-4326',
        sourceUrl: OSM_URL,
        zipPath: OSM_ZIP_PATH,
        zipName: OSM_ZIP_NAME,
        shpInZip: OSM_SHP_IN_ZIP,
        license: 'ODbL',
        attribution: '© OpenStreetMap contributors',
        select: null,
        precisions: {
            low: { simplify: '0.01' },
            medium: { simplify: '0.003' },
            high: { simplify: '0.0008' },
            full: { simplify: '' },
        },
    },
    lakes: {
        defaultPrecision: 'medium',
        description: 'Inland lakes and reservoirs, from HydroLAKES v1.0',
        source: 'HydroSHEDS / HydroLAKES v1.0',
        sourceDataset: 'HydroLAKES_polys_v10',
        sourceUrl: LAKES_URL,
        zipPath: LAKES_ZIP_PATH,
        zipName: LAKES_ZIP_NAME,
        shpInZip: LAKES_SHP_IN_ZIP,
        license: 'CC-BY-4.0',
        attribution: 'HydroLAKES v1.0 (Messager et al. 2016)',
        citation: 'Messager et al. (2016) Nature Communications 7:13603',
        // Drop the heavy attribute table; the runtime only needs geometry.
        select: 'Hylak_id',
        precisions: {
            low: { simplify: '0.01', minAreaKm2: '10' },
            medium: { simplify: '0.003', minAreaKm2: '2' },
            high: { simplify: '0.0008', minAreaKm2: '0.5' },
            full: { simplify: '', minAreaKm2: '' },
        },
    },
};

const scopeFor = (feature, precision, params) => {
    const detail = params.simplify
        ? `~${Math.round(Number(params.simplify) * 111000)} m shoreline detail`
        : 'full source shoreline detail';
    if (feature === 'lakes') {
        const floor = params.minAreaKm2
            ? `lakes ≥ ${params.minAreaKm2} km²`
            : 'all HydroLAKES lakes (≥ 0.1 km²)';
        return `${floor}; ${detail}`;
    }
    return `Oceans and seas; ${detail}`;
};

function sha256Buffer(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
    return sha256Buffer(readFileSync(filePath));
}

function humanBytes(n) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return `${v.toFixed(1)} ${units[u]}`;
}

function parseSpec(spec) {
    return spec
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((entry) => {
            const [feature, precision] = entry.split(':');
            const definition = FEATURES[feature];
            if (!definition) {
                throw new Error(
                    `Unknown feature "${feature}". Known: ${Object.keys(FEATURES).join(', ')}`
                );
            }
            const level = precision || definition.defaultPrecision;
            if (!definition.precisions[level]) {
                throw new Error(
                    `Unknown precision "${level}" for "${feature}". Known: ${Object.keys(definition.precisions).join(', ')}`
                );
            }
            return { feature, precision: level };
        });
}

/**
 * Upstream metadata is recorded beside the zip at download time so the registry
 * always describes the bytes we actually built from. A live HEAD would report
 * whatever upstream published since, which would make the update checker think
 * a stale cached build was current.
 */
function metaPathFor(zipPath) {
    return `${zipPath}.meta.json`;
}

function readCachedMeta(zipPath) {
    const metaPath = metaPathFor(zipPath);
    if (!existsSync(metaPath)) return null;
    try {
        return JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
        return null;
    }
}

async function downloadTo(url, destPath, label) {
    if (existsSync(destPath)) {
        console.log(
            `Reusing cached ${label} (${humanBytes(statSync(destPath).size)}). Delete to re-download.`
        );
        return;
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    console.log(`Downloading ${url} …`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Download failed for ${label}: HTTP ${res.status}`);
    }
    const lastModifiedHeader = res.headers.get('last-modified');
    writeFileSync(
        metaPathFor(destPath),
        `${JSON.stringify(
            {
                url,
                lastModified: lastModifiedHeader
                    ? new Date(lastModifiedHeader).toISOString()
                    : null,
                etag: res.headers.get('etag'),
                downloadedAt: new Date().toISOString(),
            },
            null,
            2
        )}\n`
    );
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let lastLogged = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
        received += chunk.length;
        if (received - lastLogged >= 50 * 1024 * 1024) {
            lastLogged = received;
            const pct = total
                ? ` (${((received / total) * 100).toFixed(0)}%)`
                : '';
            console.log(`  … ${humanBytes(received)}${pct}`);
        }
    });
    await pipeline(body, createWriteStream(destPath));
    console.log(`Saved ${destPath} (${humanBytes(statSync(destPath).size)})`);
}

function toDockerMountPath(p) {
    if (process.platform !== 'win32') return p;
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (!m) return p.replace(/\\/g, '/');
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Map a host path under the repo root to its location inside the container. */
function toWorkPath(hostPath) {
    if (process.env.USE_HOST_OGR === '1') return hostPath.replace(/\\/g, '/');
    const norm = hostPath.replace(/\\/g, '/');
    const rootNorm = ROOT.replace(/\\/g, '/');
    return norm.startsWith(rootNorm)
        ? `/work${norm.slice(rootNorm.length)}`
        : norm;
}

function dockerAvailable() {
    const result = spawnSync('docker', ['info'], {
        stdio: 'ignore',
        timeout: 60000,
    });
    return result.status === 0;
}

function runOgr(args) {
    if (process.env.USE_HOST_OGR === '1') {
        const result = spawnSync('ogr2ogr', args, {
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });
        if (result.status !== 0) {
            throw new Error(`ogr2ogr failed with status ${result.status}`);
        }
        return 'host-ogr';
    }
    if (!dockerAvailable()) {
        throw new Error('Docker not available and USE_HOST_OGR!=1');
    }
    const mount = `${toDockerMountPath(ROOT)}:/work`;
    console.log(
        `Running docker ogr2ogr (${GDAL_IMAGE}); may take several minutes with little output…`
    );
    const result = spawnSync(
        'docker',
        ['run', '--rm', '-v', mount, GDAL_IMAGE, 'ogr2ogr', ...args],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ogr2ogr failed with status ${result.status}`);
    }
    return 'docker-gdal';
}

function convertLayer({ label, definition, params, outputFgb }) {
    if (existsSync(outputFgb)) rmSync(outputFgb);

    const src = `/vsizip/${toWorkPath(definition.zipPath)}/${definition.shpInZip}`;
    const out = toWorkPath(outputFgb);

    const args = ['-f', 'FlatGeobuf', '-nlt', 'PROMOTE_TO_MULTI'];
    if (params.simplify) args.push('-simplify', params.simplify);
    if (params.minAreaKm2) {
        args.push('-where', `Lake_area >= ${params.minAreaKm2}`);
    }
    if (definition.select) args.push('-select', definition.select);
    args.push(out, src);

    console.log(
        `Converting ${label}` +
            (params.simplify ? ` (-simplify ${params.simplify})` : ' (full res)') +
            (params.minAreaKm2 ? ` (≥ ${params.minAreaKm2} km²)` : '') +
            '…'
    );
    return runOgr(args);
}

function headMeta(url) {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const result = spawnSync(bin, ['-sI', url], { encoding: 'utf8' });
    if (result.status !== 0) return { lastModified: null, etag: null };
    const headers = result.stdout || '';
    const lm = /^last-modified:\s*(.+)$/im.exec(headers);
    const et = /^etag:\s*(.+)$/im.exec(headers);
    return {
        lastModified: lm ? new Date(lm[1].trim()).toISOString() : null,
        etag: et ? et[1].trim() : null,
    };
}

/** Metadata for the zip on disk, falling back to a live HEAD for older caches. */
function sourceMetaFor(zipPath, url) {
    return readCachedMeta(zipPath) ?? headMeta(url);
}

async function countFgbFeatures(fgbBytes) {
    const { geojson } = require('flatgeobuf');
    let featureCount = 0;
    for await (const feature of geojson.deserialize(fgbBytes)) {
        if (feature.geometry) featureCount += 1;
    }
    return featureCount;
}

function readExistingRegistry() {
    if (!existsSync(REGISTRY_PATH)) return null;
    try {
        return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    } catch {
        return null;
    }
}

async function main() {
    const toBuild = parseSpec(process.env.BUILD_LAYERS || DEFAULT_BUILD);
    const bundled = new Set(
        parseSpec(process.env.BUNDLED_LAYERS || DEFAULT_BUNDLED).map(
            (s) => `${s.feature}:${s.precision}`
        )
    );

    mkdirSync(OSM_DIR, { recursive: true });
    mkdirSync(LAKES_DIR, { recursive: true });
    mkdirSync(LAYERS_DIR, { recursive: true });

    const neededFeatures = new Set(toBuild.map((s) => s.feature));
    if (neededFeatures.has('oceans')) {
        await downloadTo(OSM_URL, OSM_ZIP_PATH, OSM_ZIP_NAME);
    }
    if (neededFeatures.has('lakes')) {
        await downloadTo(LAKES_URL, LAKES_ZIP_PATH, LAKES_ZIP_NAME);
    }

    let builder = 'docker-gdal';
    const built = [];
    let oversized = false;

    for (const { feature, precision } of toBuild) {
        const definition = FEATURES[feature];
        const params = definition.precisions[precision];
        const id = `${feature}:${precision}`;
        const base = `${feature}-${precision}`;
        const tmpFgb = path.join(DATA_DIR, `_${base}.tmp.fgb`);
        const gzPath = path.join(LAYERS_DIR, `${base}.fgb.gz`);

        builder = convertLayer({
            label: `${definition.description} [${id}]`,
            definition,
            params,
            outputFgb: tmpFgb,
        });

        const fgbBytes = readFileSync(tmpFgb);
        const gzBytes = gzipSync(fgbBytes, { level: 9 });
        writeFileSync(gzPath, gzBytes);
        rmSync(tmpFgb, { force: true });

        const featureCount = await countFgbFeatures(new Uint8Array(fgbBytes));
        const isBundled = bundled.has(id);

        if (isBundled && gzBytes.length >= GITHUB_SOFT_LIMIT) {
            oversized = true;
            console.warn(
                `\n⚠ ${id} is ${humanBytes(gzBytes.length)} — too large to bundle in git.\n` +
                    `  Drop it from BUNDLED_LAYERS and publish it as a release asset instead.`
            );
        }

        built.push({
            feature,
            precision,
            delivery: isBundled ? 'bundled' : 'download',
            ...(isBundled
                ? { file: `layers/${base}.fgb.gz` }
                : { url: `${RELEASE_BASE_URL}/${base}.fgb.gz` }),
            sha256: sha256Buffer(gzBytes),
            bytes: fgbBytes.length,
            gzipBytes: gzBytes.length,
            featureCount,
            simplifyToleranceDeg: params.simplify || null,
            minAreaKm2: params.minAreaKm2 || null,
            source: definition.source,
            license: definition.license,
            attribution: definition.attribution,
            scope: scopeFor(feature, precision, params),
            ...(definition.citation ? { citation: definition.citation } : {}),
        });

        console.log(
            `Wrote ${gzPath} — ${featureCount} features, ${humanBytes(gzBytes.length)} gzip (${humanBytes(fgbBytes.length)} raw)`
        );
    }

    // Preserve artifacts built by earlier runs so building one precision does
    // not silently drop the others from the registry.
    const existing = readExistingRegistry();
    const artifacts = [...built];
    for (const prior of existing?.artifacts ?? []) {
        const replaced = built.some(
            (a) => a.feature === prior.feature && a.precision === prior.precision
        );
        if (!replaced) artifacts.push(prior);
    }
    artifacts.sort(
        (a, b) =>
            a.feature.localeCompare(b.feature) ||
            Object.keys(FEATURES[a.feature]?.precisions ?? {}).indexOf(
                a.precision
            ) -
                Object.keys(FEATURES[b.feature]?.precisions ?? {}).indexOf(
                    b.precision
                )
    );

    const sources = [];
    if (neededFeatures.has('oceans')) {
        const meta = sourceMetaFor(OSM_ZIP_PATH, OSM_URL);
        sources.push({
            id: 'osm-water-polygons',
            feature: 'oceans',
            source: FEATURES.oceans.source,
            sourceDataset: FEATURES.oceans.sourceDataset,
            sourceUrl: OSM_URL,
            sourceLastModified: meta.lastModified,
            sourceEtag: meta.etag,
            sourceZipSha256: sha256File(OSM_ZIP_PATH),
            license: FEATURES.oceans.license,
        });
    }
    if (neededFeatures.has('lakes')) {
        const meta = sourceMetaFor(LAKES_ZIP_PATH, LAKES_URL);
        sources.push({
            id: 'hydrolakes',
            feature: 'lakes',
            source: FEATURES.lakes.source,
            sourceDataset: FEATURES.lakes.sourceDataset,
            sourceUrl: LAKES_URL,
            sourceLastModified: meta.lastModified,
            sourceEtag: meta.etag,
            sourceZipSha256: sha256File(LAKES_ZIP_PATH),
            license: FEATURES.lakes.license,
            citation: FEATURES.lakes.citation,
        });
    }

    const registry = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        builder,
        defaultSelection: DEFAULT_BUNDLED,
        features: Object.fromEntries(
            Object.entries(FEATURES).map(([name, def]) => [
                name,
                {
                    defaultPrecision: def.defaultPrecision,
                    description: def.description,
                },
            ])
        ),
        sources: sources.length ? sources : (existing?.sources ?? []),
        artifacts,
    };
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);

    console.log(`\nBuilder: ${builder}`);
    console.log(`Wrote ${REGISTRY_PATH} (${artifacts.length} artifacts)`);
    if (oversized) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
