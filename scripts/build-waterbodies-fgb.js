#!/usr/bin/env node
/**
 * Build data/waterbodies.fgb.gz (+ manifest) from @geo-maps/earth-waterbodies-1m.
 *
 * Stores MultiPolygon features compactly, then gzip-compresses so the committed
 * artifact stays under GitHub's 100 MB limit. Runtime gunzips into memory and
 * explodes rings into an RBush index.
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
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FGB_PATH = path.join(DATA_DIR, 'waterbodies.fgb');
const FGB_GZ_PATH = path.join(DATA_DIR, 'waterbodies.fgb.gz');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const SOURCE_PACKAGE = '@geo-maps/earth-waterbodies-1m';
const GDAL_IMAGE =
    process.env.GDAL_IMAGE || 'ghcr.io/osgeo/gdal:alpine-small-latest';

function sha256Buffer(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
    return sha256Buffer(readFileSync(filePath));
}

function resolveSource() {
    const pkgJson = require.resolve(`${SOURCE_PACKAGE}/package.json`);
    const dir = path.dirname(pkgJson);
    const version = require(`${SOURCE_PACKAGE}/package.json`).version;
    const geoJsonPath = path.join(dir, 'map.geo.json');
    if (!existsSync(geoJsonPath)) {
        throw new Error(`Missing source GeoJSON at ${geoJsonPath}`);
    }
    return { version, geoJsonPath };
}

function toFeatureCollection(geometry) {
    const features = [];
    const push = (geom) => {
        features.push({
            type: 'Feature',
            properties: { id: features.length },
            geometry: geom,
        });
    };

    const visit = (geom) => {
        if (!geom || !geom.type) return;
        if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
            push(geom);
        } else if (geom.type === 'GeometryCollection') {
            for (const child of geom.geometries) {
                visit(child);
            }
        }
    };

    visit(geometry);
    return { type: 'FeatureCollection', features };
}

function countPolygonParts(featureCollection) {
    let count = 0;
    for (const feature of featureCollection.features) {
        const g = feature.geometry;
        if (g.type === 'Polygon') count += 1;
        else if (g.type === 'MultiPolygon') count += g.coordinates.length;
    }
    return count;
}

async function writeChunk(stream, chunk) {
    if (!stream.write(chunk)) {
        await once(stream, 'drain');
    }
}

async function writeGeoJson(fc, outPath) {
    const out = createWriteStream(outPath, { encoding: 'utf8' });
    await writeChunk(out, JSON.stringify(fc));
    out.end();
    await once(out, 'finish');
}

function dockerAvailable() {
    const result = spawnSync('docker', ['info'], {
        stdio: 'ignore',
        timeout: 15000,
    });
    return result.status === 0;
}

function buildWithGdal(tempGeoJson, outputFgb) {
    if (existsSync(outputFgb)) {
        rmSync(outputFgb);
    }

    if (process.env.USE_HOST_OGR === '1') {
        const result = spawnSync(
            'ogr2ogr',
            [
                '-f',
                'FlatGeobuf',
                '-nlt',
                'PROMOTE_TO_MULTI',
                '-lco',
                'SPATIAL_INDEX=YES',
                outputFgb,
                tempGeoJson,
            ],
            { stdio: 'inherit', shell: process.platform === 'win32' }
        );
        if (result.status !== 0) {
            throw new Error(`ogr2ogr failed with status ${result.status}`);
        }
        return 'host-ogr';
    }

    if (!dockerAvailable()) {
        throw new Error('Docker not available');
    }

    const mount = `${ROOT}:/work`;
    const result = spawnSync(
        'docker',
        [
            'run',
            '--rm',
            '-v',
            mount,
            GDAL_IMAGE,
            'ogr2ogr',
            '-f',
            'FlatGeobuf',
            '-nlt',
            'PROMOTE_TO_MULTI',
            '-lco',
            'SPATIAL_INDEX=YES',
            `/work/data/${path.basename(outputFgb)}`,
            `/work/data/${path.basename(tempGeoJson)}`,
        ],
        { stdio: 'inherit' }
    );
    if (result.status !== 0) {
        throw new Error(`docker ogr2ogr failed with status ${result.status}`);
    }
    return 'docker-gdal';
}

async function buildWithJs(fc, outputFgb) {
    const { geojson } = require('flatgeobuf');
    const bytes = geojson.serialize(fc);
    writeFileSync(outputFgb, Buffer.from(bytes));
    return 'flatgeobuf-js';
}

async function main() {
    mkdirSync(DATA_DIR, { recursive: true });

    const { version, geoJsonPath } = resolveSource();
    console.log(`Source: ${SOURCE_PACKAGE}@${version}`);
    console.log(`GeoJSON: ${geoJsonPath}`);

    console.log('Loading waterbody geometries…');
    const geometry = JSON.parse(readFileSync(geoJsonPath, 'utf8'));
    const fc = toFeatureCollection(geometry);
    const polygonPartCount = countPolygonParts(fc);
    console.log(
        `Features: ${fc.features.length} (polygon parts: ${polygonPartCount})`
    );

    let builder = process.env.FGB_BUILDER || 'auto';
    let usedBuilder;

    if (builder === 'auto') {
        try {
            const tempGeoJson = path.join(DATA_DIR, '_waterbodies.fc.geojson');
            console.log('Trying GDAL FlatGeobuf build…');
            await writeGeoJson(fc, tempGeoJson);
            usedBuilder = buildWithGdal(tempGeoJson, FGB_PATH);
            rmSync(tempGeoJson, { force: true });
        } catch (err) {
            console.warn(
                `GDAL build unavailable (${err.message}); falling back to JS serializer.`
            );
            usedBuilder = await buildWithJs(fc, FGB_PATH);
        }
    } else if (builder === 'gdal') {
        const tempGeoJson = path.join(DATA_DIR, '_waterbodies.fc.geojson');
        await writeGeoJson(fc, tempGeoJson);
        usedBuilder = buildWithGdal(tempGeoJson, FGB_PATH);
        rmSync(tempGeoJson, { force: true });
    } else if (builder === 'js') {
        usedBuilder = await buildWithJs(fc, FGB_PATH);
    } else {
        throw new Error(`Unknown FGB_BUILDER=${builder} (use auto|gdal|js)`);
    }

    const fgbBytes = readFileSync(FGB_PATH);
    const gzBytes = gzipSync(fgbBytes, { level: 9 });
    writeFileSync(FGB_GZ_PATH, gzBytes);
    // Keep uncompressed out of git; regenerate locally when needed.
    rmSync(FGB_PATH, { force: true });

    const manifest = {
        sourcePackage: SOURCE_PACKAGE,
        sourceVersion: version,
        sourceSha256: sha256File(geoJsonPath),
        fgbSha256: sha256Buffer(fgbBytes),
        fgbGzSha256: sha256Buffer(gzBytes),
        featureCount: fc.features.length,
        polygonPartCount,
        bytes: fgbBytes.length,
        gzipBytes: gzBytes.length,
        builder: usedBuilder,
        generatedAt: new Date().toISOString(),
    };

    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Builder: ${usedBuilder}`);
    console.log(
        `Wrote ${FGB_GZ_PATH} (${gzBytes.length} bytes gzip, ${fgbBytes.length} uncompressed)`
    );
    console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
