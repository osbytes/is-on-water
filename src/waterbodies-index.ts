import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, Point, Polygon, MultiPolygon } from 'geojson';

import type { LayerRegistry } from './layers';

export const REGISTRY_FILENAME = 'layers.json';

export const dataDir = (() => {
    const candidates = [
        path.join(__dirname, '..', 'data'),
        path.join(__dirname, 'data'),
        path.join(process.cwd(), 'data'),
    ];
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, REGISTRY_FILENAME))) {
            return candidate;
        }
    }
    return candidates[0];
})();

export const registryPath = path.join(dataDir, REGISTRY_FILENAME);
export const fixturesPath = path.join(dataDir, 'validation-fixtures.json');

export const loadRegistry = (filePath = registryPath): LayerRegistry => {
    if (!existsSync(filePath)) {
        throw new Error(
            `Missing layer registry at ${filePath}. Run "pnpm dataset:build" to generate it.`
        );
    }
    return JSON.parse(readFileSync(filePath, 'utf8')) as LayerRegistry;
};

/**
 * FlatGeobuf files written by GDAL carry a packed Hilbert R-tree, so a bbox
 * query reads only the pages it needs. Everything below leans on that instead
 * of building a second index in memory.
 */
export type FgbSource = Uint8Array | string;

export const readFgbBytes = (filePath: string): Uint8Array => {
    if (!existsSync(filePath)) {
        throw new Error(`Missing waterbody artifact at ${filePath}`);
    }
    const raw = readFileSync(filePath);
    return new Uint8Array(
        filePath.endsWith('.gz') ? gunzipSync(raw) : new Uint8Array(raw)
    );
};

const isWaterPolygon = (
    feature: Feature
): feature is Feature<Polygon | MultiPolygon> =>
    feature.geometry?.type === 'Polygon' ||
    feature.geometry?.type === 'MultiPolygon';

/**
 * Test a single coordinate against one FlatGeobuf source.
 *
 * The bbox is degenerate (a point). The R-tree narrows the file to the handful
 * of polygons whose envelope contains the coordinate, and only those get parsed
 * and tested exactly.
 */
export const pointInFgb = async (
    source: FgbSource,
    lon: number,
    lat: number
): Promise<boolean> => {
    const { geojson } = await import('flatgeobuf');
    const point: Point = { type: 'Point', coordinates: [lon, lat] };
    const rect = { minX: lon, minY: lat, maxX: lon, maxY: lat };

    for await (const feature of geojson.deserialize(
        source as Uint8Array,
        rect
    )) {
        if (
            isWaterPolygon(feature as Feature) &&
            booleanPointInPolygon(point, feature as Feature<Polygon>)
        ) {
            return true;
        }
    }
    return false;
};