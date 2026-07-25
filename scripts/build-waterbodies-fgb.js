#!/usr/bin/env node
/**
 * Build data/waterbodies.fgb.gz (+ manifest) by merging:
 *   1. OSM coastline water polygons (oceans & seas)
 *      https://osmdata.openstreetmap.de/data/water-polygons.html
 *   2. HydroLAKES v1.0 (inland lakes & reservoirs)
 *      https://www.hydrosheds.org/products/hydrolakes  (CC-BY 4.0)
 *
 * Defaults keep the gzip artifact under GitHub's ~100MB limit:
 *   OSM_SIMPLIFY=0.003, LAKES_SIMPLIFY=0.003, LAKES_MIN_AREA_KM2=2
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
const OSM_DIR = path.join(DATA_DIR, '_osm');
const LAKES_DIR = path.join(DATA_DIR, '_hydrolakes');

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

const FGB_PATH = path.join(DATA_DIR, 'waterbodies.fgb');
const FGB_GZ_PATH = path.join(DATA_DIR, 'waterbodies.fgb.gz');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const TMP_OCEANS_FGB = path.join(DATA_DIR, '_oceans.tmp.fgb');
const TMP_LAKES_FGB = path.join(DATA_DIR, '_lakes.tmp.fgb');

// Budget: oceans + lakes must fit under GitHub's ~100MB file limit.
// HydroLAKES ≥ 2 km² (~90k lakes) + OSM oceans, both DP-simplified at 0.003°.
// For fuller HydroLAKES (≥10 ha), set LAKES_MIN_AREA_KM2=0.1 and host the
// artifact outside git (release asset / LFS).
const DEFAULT_OSM_SIMPLIFY = '0.003';
const DEFAULT_LAKES_SIMPLIFY = '0.003';
const DEFAULT_LAKES_MIN_AREA_KM2 = '2';
const OSM_SIMPLIFY =
    process.env.OSM_SIMPLIFY !== undefined
        ? process.env.OSM_SIMPLIFY
        : DEFAULT_OSM_SIMPLIFY;
const LAKES_SIMPLIFY =
    process.env.LAKES_SIMPLIFY !== undefined
        ? process.env.LAKES_SIMPLIFY
        : DEFAULT_LAKES_SIMPLIFY;
const LAKES_MIN_AREA_KM2 =
    process.env.LAKES_MIN_AREA_KM2 !== undefined
        ? process.env.LAKES_MIN_AREA_KM2
        : DEFAULT_LAKES_MIN_AREA_KM2;

const GDAL_IMAGE =
    process.env.GDAL_IMAGE || 'ghcr.io/osgeo/gdal:alpine-normal-latest';
const GITHUB_SOFT_LIMIT = 95 * 1024 * 1024;

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
    const dockerArgs = args.map((a) =>
        typeof a === 'string' ? a.replace(/\\/g, '/') : a
    );
    // Remap host paths under ROOT to /work/...
    const remapped = dockerArgs.map((a) => {
        if (typeof a !== 'string') return a;
        const norm = a.replace(/\\/g, '/');
        const rootNorm = ROOT.replace(/\\/g, '/');
        if (norm.startsWith(rootNorm)) {
            return `/work${norm.slice(rootNorm.length)}`;
        }
        // Windows path already converted by caller to /work/...
        return a;
    });
    console.log(
        `Running docker ogr2ogr (${GDAL_IMAGE}); may take several minutes with little output…`
    );
    const result = spawnSync(
        'docker',
        ['run', '--rm', '-v', mount, GDAL_IMAGE, 'ogr2ogr', ...remapped],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ogr2ogr failed with status ${result.status}`);
    }
    return 'docker-gdal';
}

function workPath(hostPath) {
    // Paths passed into runOgr that live under the repo
    return hostPath;
}

function convertLayer({
    label,
    zipPath,
    zipName,
    shpInZip,
    simplify,
    outputFgb,
    where,
    select,
}) {
    if (existsSync(outputFgb)) rmSync(outputFgb);
    const src = process.env.USE_HOST_OGR === '1'
        ? `/vsizip/${zipPath.replace(/\\/g, '/')}/${shpInZip}`
        : `/vsizip//work/data/${path.basename(path.dirname(zipPath))}/${zipName}/${shpInZip}`;

    const out =
        process.env.USE_HOST_OGR === '1'
            ? outputFgb
            : `/work/data/${path.basename(outputFgb)}`;

    const args = ['-f', 'FlatGeobuf', '-nlt', 'PROMOTE_TO_MULTI'];
    if (simplify) {
        args.push('-simplify', simplify);
    }
    if (where) {
        args.push('-where', where);
    }
    // Drop heavy attribute tables; runtime only needs geometry.
    if (select) {
        args.push('-select', select);
    }
    args.push(out, src);

    console.log(
        `Converting ${label}` +
            (simplify ? ` (-simplify ${simplify})` : '') +
            (where ? ` (where ${where})` : '') +
            '…'
    );
    return runOgr(args);
}

function mergeLayers(oceansFgb, lakesFgb, outputFgb) {
    if (existsSync(outputFgb)) rmSync(outputFgb);

    const oceansIn =
        process.env.USE_HOST_OGR === '1'
            ? oceansFgb
            : `/work/data/${path.basename(oceansFgb)}`;
    const lakesIn =
        process.env.USE_HOST_OGR === '1'
            ? lakesFgb
            : `/work/data/${path.basename(lakesFgb)}`;
    const out =
        process.env.USE_HOST_OGR === '1'
            ? outputFgb
            : `/work/data/${path.basename(outputFgb)}`;

    console.log('Merging oceans + lakes into one FlatGeobuf (ogrmerge)…');

    // ogrmerge -single flattens heterogeneous attribute schemas into one layer.
    if (process.env.USE_HOST_OGR === '1') {
        const result = spawnSync(
            'ogrmerge',
            [
                '-o',
                out,
                '-f',
                'FlatGeobuf',
                '-single',
                '-nln',
                'waterbodies',
                '-overwrite_ds',
                oceansIn,
                lakesIn,
            ],
            { stdio: 'inherit', shell: process.platform === 'win32' }
        );
        if (result.status !== 0) {
            throw new Error(`ogrmerge failed with status ${result.status}`);
        }
        return;
    }
    if (!dockerAvailable()) {
        throw new Error('Docker not available and USE_HOST_OGR!=1');
    }
    const mount = `${toDockerMountPath(ROOT)}:/work`;
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
            out,
            '-f',
            'FlatGeobuf',
            '-single',
            '-nln',
            'waterbodies',
            '-overwrite_ds',
            oceansIn,
            lakesIn,
        ],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ogrmerge failed with status ${result.status}`);
    }
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

async function countFgbFeatures(fgbBytes) {
    const { geojson } = require('flatgeobuf');
    let featureCount = 0;
    let polygonPartCount = 0;
    for await (const feature of geojson.deserialize(fgbBytes)) {
        const g = feature.geometry;
        if (!g) continue;
        featureCount += 1;
        if (g.type === 'Polygon') polygonPartCount += 1;
        else if (g.type === 'MultiPolygon') {
            polygonPartCount += g.coordinates.length;
        }
    }
    return { featureCount, polygonPartCount };
}

async function main() {
    mkdirSync(OSM_DIR, { recursive: true });
    mkdirSync(LAKES_DIR, { recursive: true });

    await downloadTo(OSM_URL, OSM_ZIP_PATH, OSM_ZIP_NAME);
    await downloadTo(LAKES_URL, LAKES_ZIP_PATH, LAKES_ZIP_NAME);

    const lakesWhere = LAKES_MIN_AREA_KM2
        ? `Lake_area >= ${LAKES_MIN_AREA_KM2}`
        : '';

    const builderOceans = convertLayer({
        label: 'OSM oceans/seas',
        zipPath: OSM_ZIP_PATH,
        zipName: OSM_ZIP_NAME,
        shpInZip: OSM_SHP_IN_ZIP,
        simplify: OSM_SIMPLIFY,
        outputFgb: TMP_OCEANS_FGB,
    });
    convertLayer({
        label: 'HydroLAKES',
        zipPath: LAKES_ZIP_PATH,
        zipName: LAKES_ZIP_NAME,
        shpInZip: LAKES_SHP_IN_ZIP,
        simplify: LAKES_SIMPLIFY,
        outputFgb: TMP_LAKES_FGB,
        where: lakesWhere,
        select: 'Hylak_id',
    });

    mergeLayers(TMP_OCEANS_FGB, TMP_LAKES_FGB, FGB_PATH);
    rmSync(TMP_OCEANS_FGB, { force: true });
    rmSync(TMP_LAKES_FGB, { force: true });

    console.log('Gzipping and writing manifest…');
    const fgbBytes = readFileSync(FGB_PATH);
    const gzBytes = gzipSync(fgbBytes, { level: 9 });
    writeFileSync(FGB_GZ_PATH, gzBytes);
    rmSync(FGB_PATH, { force: true });

    const { featureCount, polygonPartCount } = await countFgbFeatures(
        new Uint8Array(fgbBytes)
    );
    const osmMeta = headMeta(OSM_URL);
    const lakesMeta = headMeta(LAKES_URL);
    const overLimit = gzBytes.length >= GITHUB_SOFT_LIMIT;

    const manifest = {
        sources: [
            {
                id: 'osm-water-polygons',
                source: 'osmdata.openstreetmap.de',
                sourceDataset: 'water-polygons-split-4326',
                sourceUrl: OSM_URL,
                sourceLastModified: osmMeta.lastModified,
                sourceEtag: osmMeta.etag,
                sourceZipSha256: sha256File(OSM_ZIP_PATH),
                simplifyToleranceDeg: OSM_SIMPLIFY || null,
                license: 'ODbL',
                scope: 'oceans-and-seas',
            },
            {
                id: 'hydrolakes',
                source: 'HydroSHEDS / HydroLAKES v1.0',
                sourceDataset: 'HydroLAKES_polys_v10',
                sourceUrl: LAKES_URL,
                sourceLastModified: lakesMeta.lastModified,
                sourceEtag: lakesMeta.etag,
                sourceZipSha256: sha256File(LAKES_ZIP_PATH),
                simplifyToleranceDeg: LAKES_SIMPLIFY || null,
                minAreaKm2: LAKES_MIN_AREA_KM2 || null,
                license: 'CC-BY-4.0',
                scope: 'inland-lakes-and-reservoirs-ge-10ha',
                citation:
                    'Messager et al. (2016) Nature Communications 7:13603',
            },
        ],
        // Convenience fields for update checks / tests
        source: 'osmdata.openstreetmap.de+hydrolakes',
        sourceDataset: 'water-polygons-split-4326+HydroLAKES_polys_v10',
        sourceLastModified: osmMeta.lastModified,
        sourceEtag: osmMeta.etag,
        simplifyToleranceDeg: OSM_SIMPLIFY || null,
        scope: 'oceans-seas-and-inland-lakes',
        fgbSha256: sha256Buffer(fgbBytes),
        fgbGzSha256: sha256Buffer(gzBytes),
        featureCount,
        polygonPartCount,
        bytes: fgbBytes.length,
        gzipBytes: gzBytes.length,
        builder: builderOceans,
        generatedAt: new Date().toISOString(),
    };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`Builder: ${builderOceans}`);
    console.log(
        `Features: ${featureCount} (polygon parts: ${polygonPartCount})`
    );
    console.log(
        `Wrote ${FGB_GZ_PATH} (${humanBytes(gzBytes.length)} gzip, ${humanBytes(fgbBytes.length)} uncompressed)`
    );
    console.log(`Wrote ${MANIFEST_PATH}`);
    if (overLimit) {
        console.warn(
            `\n⚠ gzip artifact is ${humanBytes(gzBytes.length)} — over GitHub's 100MB limit.\n` +
                `  Raise OSM_SIMPLIFY / LAKES_SIMPLIFY, or set LAKES_MIN_AREA_KM2 (e.g. 1).`
        );
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
