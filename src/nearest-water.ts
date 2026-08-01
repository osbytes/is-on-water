import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import area from '@turf/area';
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import polygonToLine from '@turf/polygon-to-line';
import { point as turfPoint } from '@turf/helpers';
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
} from 'geojson';

import type { FgbSource } from './waterbodies-index';

const KM_PER_DEG_LAT = 111.32;
const DEFAULT_RADII_KM = [1, 2, 5, 10, 25, 50, 100, 250, 500];
/** Hard cap on polygons inspected per layer per radius step. */
const MAX_FEATURES_PER_LAYER_STEP = 400;

export type SearchableLayer = {
    id: string;
    feature: string;
    source: FgbSource;
};

export type NearestWaterHit = {
    /** Nearest shoreline coordinate on this water body (may be on the ring). */
    lat: number;
    lon: number;
    distanceKm: number;
    areaKm2: number;
    type: string;
    layer: string;
};

export type NearestWaterOptions = {
    lat: number;
    lon: number;
    /** How many nearest water bodies to return (default 5). */
    count?: number;
    /**
     * Restrict to these feature types (e.g. `lakes`, `oceans`).
     * When omitted, every enabled layer is searched.
     */
    types?: string[];
    /** Stop expanding the search beyond this radius in km (default 100). */
    maxKm?: number;
};

export type NearestWaterResult = {
    lat: number;
    lon: number;
    water: boolean;
    layer: string | null;
    nearest: NearestWaterHit[];
};

const isPolygonFeature = (
    feature: Feature
): feature is Feature<Polygon | MultiPolygon> =>
    feature.geometry?.type === 'Polygon' ||
    feature.geometry?.type === 'MultiPolygon';

const bboxAround = (lat: number, lon: number, radiusKm: number) => {
    const dLat = radiusKm / KM_PER_DEG_LAT;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dLon = radiusKm / (KM_PER_DEG_LAT * Math.max(0.2, Math.abs(cosLat)));
    return {
        minX: lon - dLon,
        minY: lat - dLat,
        maxX: lon + dLon,
        maxY: lat + dLat,
    };
};

const featureKey = (
    layerId: string,
    feature: Feature<Polygon | MultiPolygon>
): string => {
    const geom = feature.geometry;
    const first =
        geom.type === 'Polygon'
            ? geom.coordinates[0]?.[0]
            : geom.coordinates[0]?.[0]?.[0];
    if (!first) return `${layerId}:empty`;
    return `${layerId}:${first[0].toFixed(5)},${first[1].toFixed(5)}`;
};

const asLineFeatures = (
    feature: Feature<Polygon | MultiPolygon>
): Array<Feature<LineString | MultiLineString>> => {
    const converted = polygonToLine(feature);
    if (converted.type === 'Feature') {
        return [converted as Feature<LineString | MultiLineString>];
    }
    return (converted as FeatureCollection<LineString | MultiLineString>)
        .features;
};

/**
 * Closest shoreline point on a water polygon to `origin`.
 * If the origin is inside the polygon, distance is 0 and the point is origin.
 *
 * Returned shoreline coordinates may sit exactly on the boundary and therefore
 * are not guaranteed to return `water: true` from `/api/water` (point-in-polygon
 * treats the ring as outside). That is intentional: these are nearest-shore hits.
 */
const closestOnFeature = (
    origin: Point,
    feature: Feature<Polygon | MultiPolygon>
): { lat: number; lon: number; distanceKm: number; areaKm2: number } | null => {
    const areaKm2 = area(feature) / 1_000_000;
    if (booleanPointInPolygon(origin, feature)) {
        return {
            lat: origin.coordinates[1],
            lon: origin.coordinates[0],
            distanceKm: 0,
            areaKm2,
        };
    }

    let bestDist = Number.POSITIVE_INFINITY;
    let best: { lat: number; lon: number } | null = null;
    for (const line of asLineFeatures(feature)) {
        const snapped = nearestPointOnLine(line, origin, { units: 'kilometers' });
        const d = snapped.properties?.dist;
        if (typeof d === 'number' && d < bestDist) {
            bestDist = d;
            best = {
                lon: snapped.geometry.coordinates[0],
                lat: snapped.geometry.coordinates[1],
            };
        }
    }

    if (!best || !Number.isFinite(bestDist)) {
        const ring =
            feature.geometry.type === 'Polygon'
                ? feature.geometry.coordinates[0]
                : feature.geometry.coordinates[0]?.[0];
        const vertex = ring?.[0];
        if (!vertex) return null;
        return {
            lat: vertex[1],
            lon: vertex[0],
            distanceKm: distance(origin, turfPoint(vertex), {
                units: 'kilometers',
            }),
            areaKm2,
        };
    }

    return { ...best, distanceKm: bestDist, areaKm2 };
};

const collectInRadius = async (
    layer: SearchableLayer,
    origin: Point,
    lat: number,
    lon: number,
    radiusKm: number,
    maxKm: number,
    seen: Set<string>,
    hits: Map<string, NearestWaterHit>
): Promise<void> => {
    const { geojson } = await import('flatgeobuf');
    const rect = bboxAround(lat, lon, radiusKm);
    let scanned = 0;

    for await (const raw of geojson.deserialize(
        layer.source as Uint8Array,
        rect
    )) {
        const feature = raw as Feature;
        if (!isPolygonFeature(feature)) continue;
        scanned += 1;
        if (scanned > MAX_FEATURES_PER_LAYER_STEP) break;

        const key = featureKey(layer.id, feature);
        if (seen.has(key)) continue;
        seen.add(key);

        const closest = closestOnFeature(origin, feature);
        if (!closest || closest.distanceKm > maxKm) {
            continue;
        }

        hits.set(key, {
            lat: closest.lat,
            lon: closest.lon,
            distanceKm: Number(closest.distanceKm.toFixed(4)),
            areaKm2: Number(closest.areaKm2.toFixed(4)),
            type: layer.feature,
            layer: layer.id,
        });
    }
};

const sortHits = (hits: NearestWaterHit[]): NearestWaterHit[] =>
    [...hits].sort((a, b) => {
        if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
        return b.areaKm2 - a.areaKm2;
    });

/**
 * Find nearby water polygons across enabled layers.
 * Results are ordered by ascending distance, then descending area (size).
 */
export const findNearestWater = async (
    layers: SearchableLayer[],
    options: NearestWaterOptions
): Promise<NearestWaterResult> => {
    const { lat, lon } = options;
    const count = Math.min(Math.max(options.count ?? 5, 1), 25);
    const maxKm = Math.min(Math.max(options.maxKm ?? 100, 0.1), 500);
    const typeFilter = options.types?.map((t) => t.trim().toLowerCase()).filter(Boolean);

    const selected = typeFilter?.length
        ? layers.filter((layer) => typeFilter.includes(layer.feature.toLowerCase()))
        : layers;

    if (selected.length === 0) {
        return { lat, lon, water: false, layer: null, nearest: [] };
    }

    const origin: Point = { type: 'Point', coordinates: [lon, lat] };
    const seen = new Set<string>();
    const hits = new Map<string, NearestWaterHit>();

    // Always include an exact containment check so on-water points get distance 0.
    for (const layer of selected) {
        await collectInRadius(
            layer,
            origin,
            lat,
            lon,
            0.05,
            maxKm,
            seen,
            hits
        );
    }

    const radii = DEFAULT_RADII_KM.filter((r) => r <= maxKm + 1e-9);
    if (!radii.includes(maxKm)) radii.push(maxKm);
    radii.sort((a, b) => a - b);

    for (const radiusKm of radii) {
        for (const layer of selected) {
            await collectInRadius(
                layer,
                origin,
                lat,
                lon,
                radiusKm,
                maxKm,
                seen,
                hits
            );
        }
        const ranked = sortHits([...hits.values()]);
        // Enough hits within this radius — further expansion mostly finds farther water.
        if (ranked.filter((h) => h.distanceKm <= radiusKm).length >= count) {
            break;
        }
    }

    const nearest = sortHits([...hits.values()]).slice(0, count);
    const onWater = nearest.find((h) => h.distanceKm === 0) ?? null;

    return {
        lat,
        lon,
        water: Boolean(onWater),
        layer: onWater?.layer ?? null,
        nearest,
    };
};

/** @internal exported for unit tests */
export const __test = { bboxAround, closestOnFeature, sortHits, featureKey };
