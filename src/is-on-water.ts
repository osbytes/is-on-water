import { acquireArtifact } from './layer-store';
import {
    findArtifact,
    formatSelection,
    parseLayerSelection,
    type LayerArtifact,
    type LayerRegistry,
    type LayerSelection,
} from './layers';
import { loadRegistry, pointInFgb, type FgbSource } from './waterbodies-index';

export type Coordinate = {
    lat: number;
    lon: number;
};

export type IsOnWaterResult = {
    water: boolean;
    lat: number;
    lon: number;
    /** Which enabled layer matched, or null when the coordinate is not on water. */
    layer: string | null;
};

export type LoadedLayer = {
    id: string;
    feature: string;
    precision: string;
    delivery: string;
    source: FgbSource;
    artifact: LayerArtifact;
    residentBytes: number;
};

export type LayerSummary = {
    id: string;
    feature: string;
    precision: string;
    delivery: string;
    scope?: string;
    license: string;
    attribution?: string;
    citation?: string;
    simplifyToleranceDeg?: string | null;
    minAreaKm2?: string | null;
    featureCount?: number;
};

export type InitOptions = {
    /** Raw `WATER_LAYERS` spec. Falls back to the registry default. */
    layers?: string;
    registryPath?: string;
    cacheDir?: string;
    onLayerLoaded?: (layer: LoadedLayer) => void;
};

let loadedLayers: LoadedLayer[] | null = null;
let initPromise: Promise<void> | null = null;

const loadSelection = async (
    registry: LayerRegistry,
    selection: LayerSelection,
    options: InitOptions
): Promise<LoadedLayer> => {
    const artifact = findArtifact(registry, selection) as LayerArtifact;
    const { source, residentBytes } = await acquireArtifact(artifact, {
        cacheDir: options.cacheDir,
    });
    return {
        id: formatSelection(selection),
        feature: artifact.feature,
        precision: artifact.precision,
        delivery: artifact.delivery,
        source,
        artifact,
        residentBytes,
    };
};

/**
 * Resolve the configured layer selection and make each layer queryable.
 * Safe to call multiple times; initialization runs once.
 */
export const initWaterLookup = async (
    options: InitOptions = {}
): Promise<void> => {
    if (loadedLayers) return;
    if (!initPromise) {
        initPromise = (async () => {
            const registry = loadRegistry(options.registryPath);
            const selections = parseLayerSelection(options.layers, registry);
            const layers: LoadedLayer[] = [];
            for (const selection of selections) {
                const layer = await loadSelection(registry, selection, options);
                options.onLayerLoaded?.(layer);
                layers.push(layer);
            }
            loadedLayers = layers;
        })().catch((err) => {
            // Let a later call retry rather than caching the rejection forever.
            initPromise = null;
            throw err;
        });
    }
    await initPromise;
};

export const resetWaterLookup = (): void => {
    loadedLayers = null;
    initPromise = null;
};

const requireLayers = (): LoadedLayer[] => {
    if (!loadedLayers) {
        throw new Error(
            'Water lookup not initialized. Call await initWaterLookup() before isOnWater().'
        );
    }
    return loadedLayers;
};

export const getLoadedLayers = (): LayerSummary[] =>
    requireLayers().map(({ id, feature, precision, delivery, artifact }) => ({
        id,
        feature,
        precision,
        delivery,
        scope: artifact.scope,
        license: artifact.license,
        attribution: artifact.attribution,
        citation: artifact.citation,
        simplifyToleranceDeg: artifact.simplifyToleranceDeg,
        minAreaKm2: artifact.minAreaKm2,
        featureCount: artifact.featureCount,
    }));

export const isOnWater = async ({
    lat,
    lon,
}: Coordinate): Promise<IsOnWaterResult> => {
    for (const layer of requireLayers()) {
        if (await pointInFgb(layer.source, lon, lat)) {
            return { water: true, lat, lon, layer: layer.id };
        }
    }
    return { water: false, lat, lon, layer: null };
};
