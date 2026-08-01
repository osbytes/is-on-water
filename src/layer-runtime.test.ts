import { existsSync } from 'node:fs';
import path from 'node:path';

import tap from 'tap';
import {
    getLoadedLayers,
    initWaterLookup,
    isOnWater,
    resetWaterLookup,
} from './is-on-water';

// These tests mutate a process-wide layer singleton, so they must run
// sequentially inside one parent suite.
const withLayers = async (spec: string | undefined) => {
    resetWaterLookup();
    await initWaterLookup({ layers: spec });
};

const LAKE_SUPERIOR = { lat: 47.7, lon: -87.5 };
const MID_ATLANTIC = { lat: 20.112682, lon: -37.048647 };
const TRINIDAD_RIVER = { lat: 10.691118, lon: -61.067461 };

const localPondsArtifact = path.join(
    __dirname,
    '..',
    'data',
    'layers',
    'ponds-medium.fgb.gz'
);

tap.test('layer runtime', async (t) => {
    t.test('querying before initialization is an error', async (t) => {
        resetWaterLookup();
        await t.rejects(() => isOnWater(MID_ATLANTIC), /not initialized/);
    });

    t.test('the default selection covers oceans and lakes', async (t) => {
        await withLayers(undefined);

        t.same(
            getLoadedLayers().map((l) => l.id),
            ['oceans:medium', 'lakes:medium']
        );
        t.match(await isOnWater(MID_ATLANTIC), {
            water: true,
            layer: 'oceans:medium',
        });
        t.match(await isOnWater(LAKE_SUPERIOR), {
            water: true,
            layer: 'lakes:medium',
        });
    });

    t.test('opting out of lakes drops inland coverage', async (t) => {
        await withLayers('oceans');

        t.same(
            getLoadedLayers().map((l) => l.id),
            ['oceans:medium'],
            'only the oceans layer is loaded'
        );
        t.match(
            await isOnWater(MID_ATLANTIC),
            { water: true, layer: 'oceans:medium' },
            'ocean coverage is unaffected'
        );
        t.match(
            await isOnWater(LAKE_SUPERIOR),
            { water: false, layer: null },
            'Lake Superior is no longer covered'
        );
    });

    t.test('a repeated feature collapses to its highest precision', async (t) => {
        await withLayers('lakes:medium,oceans:low,oceans:medium');

        t.same(
            getLoadedLayers().map((l) => l.id),
            ['oceans:medium', 'lakes:medium']
        );
    });

    t.test('an invalid selection fails fast at startup', async (t) => {
        resetWaterLookup();
        await t.rejects(
            () => initWaterLookup({ layers: 'swamps' }),
            /Unknown water feature "swamps"/
        );

        resetWaterLookup();
        await t.rejects(
            () => initWaterLookup({ layers: 'lakes:full' }),
            /No artifact published for "lakes:full"/
        );
    });

    t.test('a failed init can be retried', async (t) => {
        resetWaterLookup();
        await t.rejects(() => initWaterLookup({ layers: 'swamps' }));

        // The rejected promise must not be cached, or every later call would fail.
        await initWaterLookup({ layers: 'oceans' });
        t.same(
            getLoadedLayers().map((l) => l.id),
            ['oceans:medium']
        );
    });

    t.test('opting into rivers covers OSM river polygons', async (t) => {
        await withLayers('rivers');

        t.same(
            getLoadedLayers().map((l) => l.id),
            ['rivers:medium']
        );
        // Centroid of an OSM water=river polygon in Trinidad (Geofabrik CA extract).
        t.match(await isOnWater(TRINIDAD_RIVER), {
            water: true,
            layer: 'rivers:medium',
        });
        // Open ocean is not in the rivers layer.
        t.match(await isOnWater(MID_ATLANTIC), {
            water: false,
            layer: null,
        });
    });

    t.test(
        'opting into ponds covers small inland water',
        {
            skip:
                process.env.CI && !existsSync(localPondsArtifact)
                    ? 'ponds:medium is too large to download/load in CI; run locally with data/layers/ponds-medium.fgb.gz'
                    : false,
        },
        async (t) => {
            // ponds:medium is ~860 MB gzip / ~2.2 GB resident and is gitignored
            // (release asset). CI cannot download+inflate it within the suite
            // timeout; keep the assertion for local runs that have the file.
            await withLayers('ponds');

            t.same(
                getLoadedLayers().map((l) => l.id),
                ['ponds:medium']
            );
            // A HydroLAKES-scale lake must NOT appear in the ponds window (≤ 2 km²).
            t.match(
                await isOnWater(LAKE_SUPERIOR),
                { water: false, layer: null },
                'Lake Superior is above the ponds area ceiling'
            );
        }
    );

    t.test('loaded layers carry attribution metadata', async (t) => {
        await withLayers(undefined);

        for (const layer of getLoadedLayers()) {
            t.ok(layer.license, `${layer.id} declares a license`);
            t.ok(layer.scope, `${layer.id} describes its scope`);
            t.equal(layer.delivery, 'bundled', `${layer.id} ships in the repo`);
        }
    });
});
