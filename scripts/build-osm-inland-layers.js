#!/usr/bin/env node
/**
 * Build rivers and ponds FlatGeobuf layers from Geofabrik continent OSM PBFs.
 *
 *   rivers — area geometries tagged as riverbanks / river / canal
 *   ponds  — other inland water polygons (natural=water, reservoirs, lakes,
 *            ponds, …) below a surface-area ceiling so they complement the
 *            HydroLAKES layer instead of duplicating it
 *
 * Source: Geofabrik continent extracts (ODbL), read via GDAL's OSM driver.
 * Artifacts are written under data/layers/ and merged into data/layers.json.
 *
 *   BUILD_LAYERS=rivers:medium,ponds:medium
 *   GEOFABRIK_REGIONS=antarctica,australia-oceania,central-america,…
 *   BUNDLED_LAYERS=                         # empty: publish as download assets
 *   RELEASE_BASE_URL=https://github.com/osbytes/is-on-water/releases/download/data-v1
 *
 * Requires Docker (GDAL with GEOS) unless USE_HOST_OGR=1. Continent PBFs are
 * large (tens of GB total); they are cached under data/_osm_inland/.
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
    createReadStream,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { createGzip } = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LAYERS_DIR = path.join(DATA_DIR, 'layers');
const INLAND_DIR = path.join(DATA_DIR, '_osm_inland');
const REGISTRY_PATH = path.join(DATA_DIR, 'layers.json');
const OSMCONF = path.join(__dirname, 'osmconf-water.ini');

const GDAL_IMAGE =
    process.env.GDAL_IMAGE || 'ghcr.io/osgeo/gdal:alpine-normal-latest';
const GITHUB_SOFT_LIMIT = 95 * 1024 * 1024;
const RELEASE_BASE_URL =
    process.env.RELEASE_BASE_URL ||
    'https://github.com/osbytes/is-on-water/releases/download/data-v1';

const DEFAULT_BUILD = 'rivers:medium,ponds:medium';
// Global inland medium artifacts exceed GitHub's soft blob limit — publish as
// release assets (`delivery: download`) unless BUNDLED_LAYERS overrides.
const DEFAULT_BUNDLED = '';

/**
 * Continent extracts cover the whole planet without country-level duplication.
 * Override with GEOFABRIK_REGIONS for a partial/local build.
 */
const ALL_REGIONS = [
    'antarctica',
    'australia-oceania',
    'central-america',
    'south-america',
    'africa',
    'asia',
    'europe',
    'north-america',
];

const FEATURES = {
    rivers: {
        defaultPrecision: 'medium',
        description:
            'Riverbanks and canal areas from OpenStreetMap (Geofabrik extracts)',
        source: 'OpenStreetMap via Geofabrik',
        sourceDataset: 'geofabrik-continent-osm-pbf',
        license: 'ODbL',
        attribution: '© OpenStreetMap contributors (via Geofabrik)',
        // Area geometries only — stream centerlines are out of scope.
        where: `(waterway = 'riverbank' OR water IN ('river', 'canal', 'tidal_channel'))`,
        precisions: {
            low: { simplify: '0.01' },
            medium: { simplify: '0.003' },
            high: { simplify: '0.0008' },
            full: { simplify: '' },
        },
    },
    ponds: {
        defaultPrecision: 'medium',
        description:
            'Small inland water bodies (ponds, lakes, reservoirs) from OpenStreetMap, capped to complement HydroLAKES',
        source: 'OpenStreetMap via Geofabrik',
        sourceDataset: 'geofabrik-continent-osm-pbf',
        license: 'ODbL',
        attribution: '© OpenStreetMap contributors (via Geofabrik)',
        // Everything that is inland water but not a river/canal polygon.
        // Exclude swimming pools, wastewater, fountains — those are not
        // useful "is on water" hits for geographic lookups.
        where: `(natural = 'water' OR landuse = 'reservoir') AND (water IS NULL OR water NOT IN ('river', 'canal', 'wastewater', 'fountain', 'swimming_pool', 'pool', 'pools', 'rapids'))`,
        precisions: {
            // Higher precision = smaller ponds included + finer shorelines.
            low: { simplify: '0.01', maxAreaKm2: '2', minAreaKm2: '0.1' },
            medium: { simplify: '0.003', maxAreaKm2: '2', minAreaKm2: '0.01' },
            high: { simplify: '0.0008', maxAreaKm2: '2', minAreaKm2: '0.001' },
            full: { simplify: '', maxAreaKm2: '2', minAreaKm2: '' },
        },
    },
};

const WATER_EXTRACT_WHERE = `(natural = 'water' OR landuse = 'reservoir' OR waterway = 'riverbank' OR water IN ('river', 'canal', 'pond', 'basin', 'oxbow', 'lake', 'lagoon', 'reservoir', 'moat', 'reflecting_pool'))`;

function sha256Buffer(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function gzipFile(srcPath, destPath) {
    await pipeline(
        createReadStream(srcPath),
        createGzip({ level: 9 }),
        createWriteStream(destPath)
    );
}

function countFgbFeaturesViaOgr(fgbPath) {
    const mount = `${toDockerMountPath(ROOT)}:/work`;
    const result = spawnSync(
        'docker',
        [
            'run',
            '--rm',
            '-v',
            mount,
            GDAL_IMAGE,
            'ogrinfo',
            '-so',
            '-al',
            toWorkPath(fgbPath),
        ],
        { encoding: 'utf8' }
    );
    if (result.status !== 0) {
        throw new Error(
            `ogrinfo failed for ${path.basename(fgbPath)}: ${result.stderr || result.status}`
        );
    }
    const m = /Feature Count:\s*(\d+)/i.exec(result.stdout || '');
    if (!m) {
        throw new Error(
            `Could not parse feature count for ${path.basename(fgbPath)}`
        );
    }
    return Number(m[1]);
}

async function countFgbFeatures(fgbPath) {
    // Always use ogrinfo — flatgeobuf's Node stream support is unreliable and
    // can emit late errors after we delete the temp FGB.
    return countFgbFeaturesViaOgr(fgbPath);
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
    return String(spec || '')
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

function metaPathFor(filePath) {
    return `${filePath}.meta.json`;
}

function readCachedMeta(filePath) {
    const metaPath = metaPathFor(filePath);
    if (!existsSync(metaPath)) return null;
    try {
        return JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
        return null;
    }
}

function headMeta(url) {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const result = spawnSync(bin, ['-sI', '-L', url], { encoding: 'utf8' });
    if (result.status !== 0) {
        return { lastModified: null, etag: null, contentLength: null };
    }
    const headers = result.stdout || '';
    const lm = /^last-modified:\s*(.+)$/im.exec(headers);
    const et = /^etag:\s*(.+)$/im.exec(headers);
    // Last Content-Length wins after redirects.
    let contentLength = null;
    for (const m of headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)) {
        contentLength = Number(m[1]);
    }
    return {
        lastModified: lm ? new Date(lm[1].trim()).toISOString() : null,
        etag: et ? et[1].trim() : null,
        contentLength,
    };
}

function isCompleteDownload(destPath, expectedBytes) {
    if (!existsSync(destPath)) return false;
    const size = statSync(destPath).size;
    if (size <= 1024) return false;
    // Without a known total, only treat as complete if a prior run marked it.
    if (!expectedBytes || expectedBytes <= 0) {
        return Boolean(readCachedMeta(destPath)?.downloadedAt);
    }
    // Allow a tiny slack for servers that omit trailers inconsistently.
    return size >= expectedBytes * 0.995;
}

async function downloadTo(url, destPath, label) {
    const meta = headMeta(url);
    const expected = meta.contentLength;
    if (isCompleteDownload(destPath, expected)) {
        console.log(
            `Reusing cached ${label} (${humanBytes(statSync(destPath).size)}). Delete to re-download.`
        );
        if (!readCachedMeta(destPath)) {
            writeFileSync(
                metaPathFor(destPath),
                `${JSON.stringify(
                    {
                        url,
                        lastModified: meta.lastModified,
                        etag: meta.etag,
                        contentLength: expected,
                        downloadedAt: null,
                        notedAt: new Date().toISOString(),
                    },
                    null,
                    2
                )}\n`
            );
        }
        return;
    }
    if (existsSync(destPath) && statSync(destPath).size > 1024) {
        console.log(
            `Incomplete ${label} (${humanBytes(statSync(destPath).size)}${
                expected ? ` / ${humanBytes(expected)}` : ''
            }); re-downloading…`
        );
        rmSync(destPath);
    }
    mkdirSync(path.dirname(destPath), { recursive: true });
    console.log(`Downloading ${url} …`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`Download failed for ${label}: HTTP ${res.status}`);
    }
    const lastModifiedHeader = res.headers.get('last-modified');
    const total =
        Number(res.headers.get('content-length')) || expected || 0;
    writeFileSync(
        metaPathFor(destPath),
        `${JSON.stringify(
            {
                url,
                lastModified: lastModifiedHeader
                    ? new Date(lastModifiedHeader).toISOString()
                    : meta.lastModified,
                etag: res.headers.get('etag') || meta.etag,
                contentLength: total || null,
                downloadedAt: new Date().toISOString(),
            },
            null,
            2
        )}\n`
    );
    let received = 0;
    let lastLogged = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
        received += chunk.length;
        if (received - lastLogged >= 100 * 1024 * 1024) {
            lastLogged = received;
            const pct = total
                ? ` (${((received / total) * 100).toFixed(0)}%)`
                : '';
            console.log(`  … ${humanBytes(received)}${pct}`);
        }
    });
    await pipeline(body, createWriteStream(destPath));
    const finalSize = statSync(destPath).size;
    if (total > 0 && finalSize < total * 0.995) {
        throw new Error(
            `Download incomplete for ${label}: got ${humanBytes(finalSize)}, expected ${humanBytes(total)}`
        );
    }
    console.log(`Saved ${destPath} (${humanBytes(finalSize)})`);
}

function toDockerMountPath(p) {
    if (process.platform !== 'win32') return p;
    // Docker Desktop accepts Windows paths. WSL-style /mnt/<drive> only works
    // when the CLI talks to a Linux dockerd inside WSL — opt in via env.
    if (process.env.DOCKER_MOUNT_STYLE === 'wsl') {
        const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
        if (!m) return p.replace(/\\/g, '/');
        return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    }
    return p.replace(/\\/g, '/');
}

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

function runDocker(argv, label) {
    if (!dockerAvailable()) {
        throw new Error(`Docker not available (${label})`);
    }
    const mount = `${toDockerMountPath(ROOT)}:/work`;
    console.log(`Running docker ${label}…`);
    const result = spawnSync(
        'docker',
        ['run', '--rm', '-v', mount, GDAL_IMAGE, ...argv],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ${label} failed with status ${result.status}`);
    }
    return 'docker-gdal';
}

function runOgr(args) {
    if (process.env.USE_HOST_OGR === '1') {
        const result = spawnSync(
            'ogr2ogr',
            ['--config', 'OSM_CONFIG_FILE', OSMCONF, ...args],
            { stdio: 'inherit', shell: process.platform === 'win32', env: {
                ...process.env,
                OSM_CONFIG_FILE: OSMCONF,
            } }
        );
        if (result.status !== 0) {
            throw new Error(`ogr2ogr failed with status ${result.status}`);
        }
        return 'host-ogr';
    }
    return runDocker(
        [
            'ogr2ogr',
            '--config',
            'OSM_CONFIG_FILE',
            toWorkPath(OSMCONF),
            ...args,
        ],
        'ogr2ogr'
    );
}

function areaSql(params) {
    // Web Mercator area is approximate but good enough for pond size filters.
    const areaKm2 = `ST_Area(ST_Transform(geometry, 3857)) / 1000000.0`;
    const clauses = [];
    if (params.minAreaKm2) clauses.push(`${areaKm2} >= ${params.minAreaKm2}`);
    if (params.maxAreaKm2) clauses.push(`${areaKm2} < ${params.maxAreaKm2}`);
    return clauses;
}

function scopeFor(feature, params, regions) {
    const detail = params.simplify
        ? `~${Math.round(Number(params.simplify) * 111000)} m shoreline detail`
        : 'full source shoreline detail';
    const regionNote =
        regions.length === ALL_REGIONS.length
            ? 'global'
            : `regions: ${regions.join(', ')}`;
    if (feature === 'rivers') {
        return `OSM riverbank / river / canal area geometries (${regionNote}); ${detail}`;
    }
    const floor = params.minAreaKm2
        ? `${params.minAreaKm2}–${params.maxAreaKm2 || '∞'} km²`
        : `< ${params.maxAreaKm2 || '∞'} km²`;
    return `OSM ponds/lakes/reservoirs ${floor} (${regionNote}; complements HydroLAKES); ${detail}`;
}

function regionPbfPath(region) {
    return path.join(INLAND_DIR, `${region}-latest.osm.pbf`);
}

function regionUrl(region) {
    return `https://download.geofabrik.de/${region}-latest.osm.pbf`;
}

function regionWaterFgb(region) {
    return path.join(INLAND_DIR, `${region}-water.tmp.fgb`);
}

/**
 * Optional: extract large continent PBFs on a WSL-native ext4 dir when the
 * Docker engine is a remote Linux dockerd over slow 9p mounts.
 * Disabled by default (Docker Desktop + fast host SSD is fine).
 * Set OSM_NATIVE_WORK=/path to enable, or OSM_NATIVE_WORK=0 to force off.
 */
function nativeOsmWorkDir() {
    if (process.env.OSM_NATIVE_WORK === '0') return null;
    if (process.env.OSM_NATIVE_WORK) return process.env.OSM_NATIVE_WORK;
    return null;
}

function extractRegionWaterViaNative(region) {
    const script = toDockerMountPath(
        path.join(__dirname, '_extract-native.sh')
    );
    const repo = toDockerMountPath(ROOT);
    const native = nativeOsmWorkDir();
    console.log(`Extracting ${region} via WSL native disk (${native})…`);
    // Pass env inside the Linux shell — Windows env is not forwarded by wsl.exe.
    const result = spawnSync(
        'wsl',
        [
            '-d',
            'Ubuntu',
            '--',
            'bash',
            '-lc',
            `REPO='${repo}' OSM_NATIVE_WORK='${native}' GDAL_IMAGE='${GDAL_IMAGE}' bash '${script}' '${region}'`,
        ],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(
            `native extract ${region} failed with status ${result.status}`
        );
    }
}

function extractRegionWater(region) {
    const pbf = regionPbfPath(region);
    const out = regionWaterFgb(region);
    if (existsSync(out) && statSync(out).size > 0) {
        console.log(
            `Reusing ${path.basename(out)} (${humanBytes(statSync(out).size)})`
        );
        return;
    }
    if (existsSync(out)) rmSync(out);
    console.log(`Extracting inland water polygons from ${region}…`);
    const useNative =
        nativeOsmWorkDir() &&
        existsSync(pbf) &&
        statSync(pbf).size >= 2 * 1024 * 1024 * 1024;
    if (useNative) {
        extractRegionWaterViaNative(region);
    } else {
        runOgr([
            '-f',
            'FlatGeobuf',
            '-nlt',
            'PROMOTE_TO_MULTI',
            '-nln',
            'water',
            '-where',
            WATER_EXTRACT_WHERE,
            '-select',
            'natural,landuse,waterway,water',
            toWorkPath(out),
            toWorkPath(pbf),
            'multipolygons',
        ]);
    }
    console.log(
        `  → ${path.basename(out)} (${humanBytes(statSync(out).size)})`
    );
}

function mergeRegionWater(regionFgbs, outputFgb) {
    if (
        existsSync(outputFgb) &&
        statSync(outputFgb).size > 0 &&
        process.env.FORCE_MERGE !== '1'
    ) {
        console.log(
            `Reusing ${path.basename(outputFgb)} (${humanBytes(statSync(outputFgb).size)})`
        );
        return;
    }
    if (existsSync(outputFgb)) rmSync(outputFgb);
    if (regionFgbs.length === 1) {
        // Single region: copy with a stable layer name for downstream SQL.
        runOgr([
            '-f',
            'FlatGeobuf',
            '-nlt',
            'PROMOTE_TO_MULTI',
            '-nln',
            'water',
            toWorkPath(outputFgb),
            toWorkPath(regionFgbs[0]),
        ]);
        return;
    }

    const mount = `${toDockerMountPath(ROOT)}:/work`;
    const inputs = regionFgbs.map(toWorkPath);
    console.log(`Merging ${regionFgbs.length} regional water extracts…`);
    if (process.env.USE_HOST_OGR === '1') {
        const result = spawnSync(
            'ogrmerge',
            [
                '-o',
                outputFgb,
                '-f',
                'FlatGeobuf',
                '-single',
                '-nln',
                'water',
                '-overwrite_ds',
                ...regionFgbs,
            ],
            { stdio: 'inherit', shell: process.platform === 'win32' }
        );
        if (result.status !== 0) {
            throw new Error(`ogrmerge failed with status ${result.status}`);
        }
        return;
    }
    const result = spawnSync(
        'docker',
        [
            'run',
            '--rm',
            '-v',
            mount,
            GDAL_IMAGE,
            'ogrmerge',
            '-o',
            toWorkPath(outputFgb),
            '-f',
            'FlatGeobuf',
            '-single',
            '-nln',
            'water',
            '-overwrite_ds',
            ...inputs,
        ],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ogrmerge failed with status ${result.status}`);
    }
}

function convertFeature({ feature, precision, params, sourceFgb, outputFgb }) {
    if (
        existsSync(outputFgb) &&
        statSync(outputFgb).size > 0 &&
        process.env.FORCE_CONVERT !== '1'
    ) {
        console.log(
            `Reusing ${path.basename(outputFgb)} (${humanBytes(statSync(outputFgb).size)})`
        );
        return 'reused';
    }
    if (existsSync(outputFgb)) rmSync(outputFgb);
    const definition = FEATURES[feature];
    const whereParts = [definition.where, ...areaSql(params)];
    const args = [
        '-f',
        'FlatGeobuf',
        '-nlt',
        'PROMOTE_TO_MULTI',
        '-dialect',
        'SQLite',
        '-sql',
        `SELECT geometry FROM water WHERE ${whereParts.join(' AND ')}`,
    ];
    if (params.simplify) {
        // -simplify applies after SQL; use it on a second pass via -simplify flag
        // on the same ogr2ogr when not using -sql geometry rewrite... Actually
        // -simplify works with -sql in GDAL. Keep it.
        args.push('-simplify', params.simplify);
    }
    args.push(toWorkPath(outputFgb), toWorkPath(sourceFgb));

    console.log(
        `Building ${feature}:${precision}` +
            (params.simplify ? ` (-simplify ${params.simplify})` : ' (full res)') +
            (params.minAreaKm2 || params.maxAreaKm2
                ? ` (area ${params.minAreaKm2 || '0'}–${params.maxAreaKm2 || '∞'} km²)`
                : '') +
            '…'
    );
    return runOgr(args);
}

function readExistingRegistry() {
    if (!existsSync(REGISTRY_PATH)) return null;
    try {
        return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function resolveRegions() {
    const raw = process.env.GEOFABRIK_REGIONS?.trim();
    if (!raw) return ALL_REGIONS;
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

async function main() {
    const toBuild = parseSpec(process.env.BUILD_LAYERS || DEFAULT_BUILD);
    if (toBuild.length === 0) {
        throw new Error('BUILD_LAYERS is empty');
    }
    const bundledSpec =
        process.env.BUNDLED_LAYERS !== undefined
            ? process.env.BUNDLED_LAYERS
            : DEFAULT_BUNDLED;
    const bundled = new Set(
        parseSpec(bundledSpec).map((s) => `${s.feature}:${s.precision}`)
    );
    const regions = resolveRegions();

    mkdirSync(INLAND_DIR, { recursive: true });
    mkdirSync(LAYERS_DIR, { recursive: true });

    console.log(`Regions: ${regions.join(', ')}`);
    for (const region of regions) {
        await downloadTo(
            regionUrl(region),
            regionPbfPath(region),
            `${region}-latest.osm.pbf`
        );
        extractRegionWater(region);
    }

    const mergedWater = path.join(INLAND_DIR, '_world-water.tmp.fgb');
    mergeRegionWater(
        regions.map(regionWaterFgb),
        mergedWater
    );

    let builder = 'docker-gdal';
    const built = [];
    let oversized = false;

    for (const { feature, precision } of toBuild) {
        const params = FEATURES[feature].precisions[precision];
        const id = `${feature}:${precision}`;
        const base = `${feature}-${precision}`;
        const tmpFgb = path.join(DATA_DIR, `_${base}.tmp.fgb`);
        const gzPath = path.join(LAYERS_DIR, `${base}.fgb.gz`);

        builder = convertFeature({
            feature,
            precision,
            params,
            sourceFgb: mergedWater,
            outputFgb: tmpFgb,
        });

        const rawBytes = statSync(tmpFgb).size;
        console.log(
            `Compressing ${path.basename(tmpFgb)} (${humanBytes(rawBytes)})…`
        );
        await gzipFile(tmpFgb, gzPath);
        const gzipBytes = statSync(gzPath).size;
        const sha256 = await sha256File(gzPath);
        const featureCount = await countFgbFeatures(tmpFgb);
        rmSync(tmpFgb, { force: true });

        const isBundled = bundled.has(id);
        if (isBundled && gzipBytes >= GITHUB_SOFT_LIMIT) {
            oversized = true;
            console.warn(
                `\n⚠ ${id} is ${humanBytes(gzipBytes)} — too large to bundle in git.`
            );
        }

        built.push({
            feature,
            precision,
            delivery: isBundled ? 'bundled' : 'download',
            ...(isBundled
                ? { file: `layers/${base}.fgb.gz` }
                : { url: `${RELEASE_BASE_URL}/${base}.fgb.gz` }),
            sha256,
            bytes: rawBytes,
            gzipBytes,
            featureCount,
            simplifyToleranceDeg: params.simplify || null,
            minAreaKm2: params.minAreaKm2 || null,
            maxAreaKm2: params.maxAreaKm2 || null,
            source: FEATURES[feature].source,
            license: FEATURES[feature].license,
            attribution: FEATURES[feature].attribution,
            scope: scopeFor(feature, params, regions),
        });

        console.log(
            `Wrote ${gzPath} — ${featureCount} features, ${humanBytes(gzipBytes)} gzip (${humanBytes(rawBytes)} raw)`
        );
    }

    rmSync(mergedWater, { force: true });

    const existing = readExistingRegistry();
    if (!existing) {
        throw new Error(
            `Missing ${REGISTRY_PATH}. Build oceans/lakes first (pnpm dataset:build).`
        );
    }

    const artifacts = [...built];
    for (const prior of existing.artifacts ?? []) {
        const replaced = built.some(
            (a) => a.feature === prior.feature && a.precision === prior.precision
        );
        if (!replaced) artifacts.push(prior);
    }
    artifacts.sort(
        (a, b) =>
            a.feature.localeCompare(b.feature) ||
            String(a.precision).localeCompare(String(b.precision))
    );

    const regionMetas = [];
    for (const region of regions) {
        const pbf = regionPbfPath(region);
        const meta = readCachedMeta(pbf) || {};
        regionMetas.push({
            region,
            sourceUrl: regionUrl(region),
            sourceLastModified: meta.lastModified ?? null,
            sourceEtag: meta.etag ?? null,
            sourcePbfSha256: existsSync(pbf) ? await sha256File(pbf) : null,
            bytes: existsSync(pbf) ? statSync(pbf).size : null,
        });
    }

    const sources = [
        ...(existing.sources || []).filter(
            (s) => s.id !== 'osm-geofabrik-inland-water'
        ),
        {
            id: 'osm-geofabrik-inland-water',
            feature: 'rivers,ponds',
            source: 'OpenStreetMap via Geofabrik',
            sourceDataset: 'continent-latest.osm.pbf',
            sourceUrl: 'https://download.geofabrik.de/',
            license: 'ODbL',
            regions: regionMetas,
        },
    ];

    const features = {
        ...existing.features,
        rivers: {
            defaultPrecision: FEATURES.rivers.defaultPrecision,
            description: FEATURES.rivers.description,
        },
        ponds: {
            defaultPrecision: FEATURES.ponds.defaultPrecision,
            description: FEATURES.ponds.description,
        },
    };

    const registry = {
        ...existing,
        generatedAt: new Date().toISOString(),
        builder,
        features,
        sources,
        artifacts,
    };
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);

    console.log(`\nBuilder: ${builder}`);
    console.log(`Updated ${REGISTRY_PATH} (${artifacts.length} artifacts)`);
    if (oversized) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
