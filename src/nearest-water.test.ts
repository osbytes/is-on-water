import tap from 'tap';
import { initWaterLookup, nearestWater, resetWaterLookup } from './is-on-water';
import { __test } from './nearest-water';

tap.test('nearest-water helpers', async (t) => {
    const ranked = __test.sortHits([
        {
            lat: 0,
            lon: 0,
            distanceKm: 2,
            areaKm2: 10,
            type: 'lakes',
            layer: 'lakes:medium',
        },
        {
            lat: 0,
            lon: 0,
            distanceKm: 1,
            areaKm2: 1,
            type: 'lakes',
            layer: 'lakes:medium',
        },
        {
            lat: 0,
            lon: 0,
            distanceKm: 1,
            areaKm2: 50,
            type: 'lakes',
            layer: 'lakes:medium',
        },
    ]);
    t.equal(ranked[0].distanceKm, 1);
    t.equal(ranked[0].areaKm2, 50, 'same distance → larger area first');
    t.equal(ranked[1].areaKm2, 1);
    t.equal(ranked[2].distanceKm, 2);
});

tap.test('nearestWater', async (t) => {
    t.before(async () => {
        resetWaterLookup();
        await initWaterLookup();
    });

    t.test('returns the query point at distance 0 when already on water', async (t) => {
        const result = await nearestWater({
            lat: 47.7,
            lon: -87.5,
            count: 3,
            types: ['lakes'],
            maxKm: 50,
        });
        t.equal(result.water, true);
        t.equal(result.layer, 'lakes:medium');
        t.ok(result.nearest.length >= 1);
        t.equal(result.nearest[0].distanceKm, 0);
        t.equal(result.nearest[0].type, 'lakes');
        t.equal(result.nearest[0].layer, 'lakes:medium');
    });

    t.test('finds nearby lakes from inland land and respects count/type', async (t) => {
        // Land just south of Lake Superior
        const result = await nearestWater({
            lat: 46.5,
            lon: -87.5,
            count: 2,
            types: ['lakes'],
            maxKm: 150,
        });
        t.equal(result.water, false);
        t.equal(result.nearest.length, 2);
        t.ok(result.nearest[0].distanceKm > 0);
        t.ok(
            result.nearest[0].distanceKm <= result.nearest[1].distanceKm,
            'ordered by distance'
        );
        for (const hit of result.nearest) {
            t.equal(hit.type, 'lakes');
        }
    });

    t.test('filters by type so oceans-only skips inland lakes', async (t) => {
        const lakes = await nearestWater({
            lat: 46.5,
            lon: -87.5,
            count: 1,
            types: ['lakes'],
            maxKm: 150,
        });
        const oceans = await nearestWater({
            lat: 46.5,
            lon: -87.5,
            count: 1,
            types: ['oceans'],
            maxKm: 50,
        });
        t.equal(lakes.nearest[0]?.type, 'lakes');
        t.ok(
            oceans.nearest.length === 0 ||
                oceans.nearest[0].distanceKm > lakes.nearest[0].distanceKm,
            'ocean shoreline is much farther than Lake Superior here'
        );
    });
});
