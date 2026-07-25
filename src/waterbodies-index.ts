import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import RBush from 'rbush';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Feature, Point, Polygon, MultiPolygon } from 'geojson';

export type BBoxItem = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    feature: Feature<Polygon>;
};

export type DatasetManifest = {
    source: string;
    sourceDataset: string;
    sourceUrl?: string;
    sourceLastModified?: string | null;
    sourceEtag?: string | null;
    sourceZipSha256?: string;
    simplifyToleranceDeg?: string | null;
    scope?: string;
    sources?: Array<{
        id: string;
        source: string;
        sourceDataset: string;
        sourceUrl: string;
        sourceLastModified?: string | null;
        sourceEtag?: string | null;
        sourceZipSha256?: string | null;
        simplifyToleranceDeg?: string | null;
        minAreaKm2?: string | null;
        license?: string;
        scope?: string;
        citation?: string;
    }>;
    fgbSha256: string;
    fgbGzSha256?: string;
    featureCount: number;
    polygonPartCount?: number;
    bytes: number;
    gzipBytes?: number;
    builder?: string;
    generatedAt: string;
};

export const dataDir = (() => {
    const candidates = [
        path.join(__dirname, '..', 'data'),
        path.join(__dirname, 'data'),
        path.join(process.cwd(), 'data'),
    ];
    for (const candidate of candidates) {
        if (
            existsSync(path.join(candidate, 'waterbodies.fgb.gz')) ||
            existsSync(path.join(candidate, 'waterbodies.fgb'))
        ) {
            return candidate;
        }
    }
    return candidates[0];
})();
export const fgbPath = path.join(dataDir, 'waterbodies.fgb');
export const fgbGzPath = path.join(dataDir, 'waterbodies.fgb.gz');
export const manifestPath = path.join(dataDir, 'manifest.json');
export const fixturesPath = path.join(dataDir, 'validation-fixtures.json');

function polygonBBox(
    coordinates: Polygon['coordinates']
): [number, number, number, number] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of coordinates) {
        for (const position of ring) {
            const x = position[0];
            const y = position[1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    return [minX, minY, maxX, maxY];
}

/**
 * Explode MultiPolygon features into per-polygon RBush items so ocean-scale
 * MultiPolygon bboxes do not defeat spatial filtering.
 */
export function featuresToIndexItems(
    features: Feature<Polygon | MultiPolygon>[]
): BBoxItem[] {
    const items: BBoxItem[] = [];
    for (const feature of features) {
        const geometry = feature.geometry;
        if (geometry.type === 'Polygon') {
            const [minX, minY, maxX, maxY] = polygonBBox(geometry.coordinates);
            items.push({
                minX,
                minY,
                maxX,
                maxY,
                feature: {
                    type: 'Feature',
                    properties: feature.properties ?? {},
                    geometry,
                },
            });
        } else if (geometry.type === 'MultiPolygon') {
            for (const coordinates of geometry.coordinates) {
                const [minX, minY, maxX, maxY] = polygonBBox(coordinates);
                items.push({
                    minX,
                    minY,
                    maxX,
                    maxY,
                    feature: {
                        type: 'Feature',
                        properties: feature.properties ?? {},
                        geometry: { type: 'Polygon', coordinates },
                    },
                });
            }
        }
    }
    return items;
}

export function loadManifest(filePath = manifestPath): DatasetManifest {
    return JSON.parse(readFileSync(filePath, 'utf8')) as DatasetManifest;
}

export function readFgbBytes(
    preferredGzPath = fgbGzPath,
    preferredFgbPath = fgbPath
): Uint8Array {
    if (existsSync(preferredGzPath)) {
        return new Uint8Array(gunzipSync(readFileSync(preferredGzPath)));
    }
    if (existsSync(preferredFgbPath)) {
        return new Uint8Array(readFileSync(preferredFgbPath));
    }
    throw new Error(
        `Missing waterbodies dataset at ${preferredGzPath} or ${preferredFgbPath}`
    );
}

export async function loadFeaturesFromFgb(
    filePathGz = fgbGzPath,
    filePathFgb = fgbPath
): Promise<Feature<Polygon | MultiPolygon>[]> {
    const { geojson } = await import('flatgeobuf');
    const bytes = readFgbBytes(filePathGz, filePathFgb);
    const features: Feature<Polygon | MultiPolygon>[] = [];
    for await (const feature of geojson.deserialize(bytes)) {
        const geometry = feature.geometry;
        if (
            geometry &&
            (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
        ) {
            features.push(feature as Feature<Polygon | MultiPolygon>);
        }
    }
    return features;
}

export function buildWaterIndex(
    features: Feature<Polygon | MultiPolygon>[]
): RBush<BBoxItem> {
    const tree = new RBush<BBoxItem>();
    tree.load(featuresToIndexItems(features));
    return tree;
}

export function pointInWaterIndex(
    tree: RBush<BBoxItem>,
    lon: number,
    lat: number
): boolean {
    const candidates = tree.search({
        minX: lon,
        minY: lat,
        maxX: lon,
        maxY: lat,
    });
    const point: Point = {
        type: 'Point',
        coordinates: [lon, lat],
    };
    for (const candidate of candidates) {
        if (booleanPointInPolygon(point, candidate.feature)) {
            return true;
        }
    }
    return false;
}
