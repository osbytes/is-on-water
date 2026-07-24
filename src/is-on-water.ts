import {
    buildWaterIndex,
    loadFeaturesFromFgb,
    pointInWaterIndex,
    type BBoxItem,
} from './waterbodies-index';
import type RBush from 'rbush';

export type Coordinate = {
    lat: number;
    lon: number;
};

export type IsOnWaterResult = {
    water: boolean;
    lat: number;
    lon: number;
};

let waterIndex: RBush<BBoxItem> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Load FlatGeobuf waterbodies and build the in-memory spatial index.
 * Safe to call multiple times; initialization runs once.
 */
export const initWaterLookup = async (): Promise<void> => {
    if (waterIndex) return;
    if (!initPromise) {
        initPromise = (async () => {
            const features = await loadFeaturesFromFgb();
            waterIndex = buildWaterIndex(features);
        })();
    }
    await initPromise;
};

export const isOnWater = ({ lat, lon }: Coordinate): IsOnWaterResult => {
    if (!waterIndex) {
        throw new Error(
            'Water lookup not initialized. Call await initWaterLookup() before isOnWater().'
        );
    }

    return {
        water: pointInWaterIndex(waterIndex, lon, lat),
        lat,
        lon,
    };
};
