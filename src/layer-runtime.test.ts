import tap from 'tap';
import {
    getLoadedLayers,
    initWaterLookup,
    isOnWater,
    resetWaterLookup,
} from './is-on-water';

// tap runs each test file in its own process, so re-initializing the layer
// singleton here does not disturb the other suites.
const withLayers = async (spec: string | undefined) => {
    resetWaterLookup();
    await initWaterLookup({ layers: spec });
};

const LAKE_SUPERIOR = { lat: 47.7, lon: -87.5 };
const MID_ATLANTIC = { lat: 20.112682, lon: -37.048647 };

tap.test('querying before initialization is an error', async (t) => {
    resetWaterLookup();
    await t.rejects(() => isOnWater(MID_ATLANTIC), /not initialized/);
});

tap.test('the default selection covers oceans and lakes', async (t) => {
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

tap.test('opting out of lakes drops inland coverage', async (t) => {
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

tap.test('a repeated feature collapses to its highest precision', async (t) => {
    await withLayers('lakes:medium,oceans:low,oceans:medium');

    t.same(
        getLoadedLayers().map((l) => l.id),
        ['oceans:medium', 'lakes:medium']
    );
});

tap.test('an invalid selection fails fast at startup', async (t) => {
    resetWaterLookup();
    await t.rejects(
        () => initWaterLookup({ layers: 'rivers' }),
        /Unknown water feature "rivers"/
    );

    resetWaterLookup();
    await t.rejects(
        () => initWaterLookup({ layers: 'lakes:full' }),
        /No artifact published for "lakes:full"/
    );
});

tap.test('a failed init can be retried', async (t) => {
    resetWaterLookup();
    await t.rejects(() => initWaterLookup({ layers: 'rivers' }));

    // The rejected promise must not be cached, or every later call would fail.
    await initWaterLookup({ layers: 'oceans' });
    t.same(
        getLoadedLayers().map((l) => l.id),
        ['oceans:medium']
    );
});

tap.test('loaded layers carry attribution metadata', async (t) => {
    await withLayers(undefined);

    for (const layer of getLoadedLayers()) {
        t.ok(layer.license, `${layer.id} declares a license`);
        t.ok(layer.scope, `${layer.id} describes its scope`);
        t.equal(layer.delivery, 'bundled', `${layer.id} ships in the repo`);
    }
});
