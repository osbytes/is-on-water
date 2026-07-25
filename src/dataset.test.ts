import tap from 'tap';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type RBush from 'rbush';
import {
    buildWaterIndex,
    fixturesPath,
    fgbGzPath,
    fgbPath,
    loadFeaturesFromFgb,
    loadManifest,
    manifestPath,
    pointInWaterIndex,
    readFgbBytes,
    type BBoxItem,
} from '../src/waterbodies-index';

type ValidationFixture = {
    id: string;
    lat: number;
    lon: number;
    water: boolean;
    critical: boolean;
    note?: string;
};

type ValidationFixturesFile = {
    description: string;
    fixtures: ValidationFixture[];
};

const sha256 = (buf: Buffer | Uint8Array) =>
    createHash('sha256').update(buf).digest('hex');

let sharedIndex: RBush<BBoxItem> | null = null;
let sharedFeatureCount = 0;

tap.before(async () => {
    const features = await loadFeaturesFromFgb();
    sharedFeatureCount = features.length;
    sharedIndex = buildWaterIndex(features);
});

tap.test('dataset artifacts exist', async (t) => {
    t.ok(
        existsSync(fgbGzPath) || existsSync(fgbPath),
        `missing ${fgbGzPath} (or uncompressed ${fgbPath})`
    );
    t.ok(existsSync(manifestPath), `missing ${manifestPath}`);
    t.ok(existsSync(fixturesPath), `missing ${fixturesPath}`);
});

tap.test('manifest matches waterbodies FlatGeobuf', async (t) => {
    const manifest = loadManifest();
    const bytes = readFgbBytes();
    const gzSize = existsSync(fgbGzPath) ? statSync(fgbGzPath).size : null;

    t.equal(manifest.source, 'osmdata.openstreetmap.de+hydrolakes');
    t.match(manifest.sourceDataset, /HydroLAKES/);
    t.equal(manifest.scope, 'oceans-seas-and-inland-lakes');
    t.ok(Array.isArray(manifest.sources) && manifest.sources.length >= 2);
    t.type(manifest.sourceLastModified, 'string');
    t.ok(manifest.simplifyToleranceDeg, 'expected a pinned simplify tolerance');
    t.equal(manifest.fgbSha256, sha256(bytes));
    t.equal(manifest.bytes, bytes.byteLength);
    if (gzSize != null && manifest.gzipBytes != null) {
        t.equal(manifest.gzipBytes, gzSize);
        t.ok(
            gzSize < 95 * 1024 * 1024,
            'gzip artifact should stay under GitHub 100MB limit'
        );
    }
    t.ok(manifest.featureCount >= 1, 'expected at least one waterbody feature');
    t.ok(
        (manifest.polygonPartCount ?? 0) > 1000 ||
            manifest.featureCount > 1000,
        'expected a global waterbody polygon part count'
    );
    t.ok(
        bytes.byteLength > 1_000_000,
        'FlatGeobuf should be non-trivial in size'
    );
});

tap.test('FlatGeobuf loads and indexes', async (t) => {
    const manifest = loadManifest();
    t.equal(
        sharedFeatureCount,
        manifest.featureCount,
        'top-level feature count should match manifest'
    );

    const expectedParts = manifest.polygonPartCount ?? sharedFeatureCount;
    t.equal(
        sharedIndex!.all().length,
        expectedParts,
        'indexed polygon parts should match manifest'
    );
});

tap.test('validation fixtures against current dataset', async (t) => {
    const fixturesFile = JSON.parse(
        readFileSync(fixturesPath, 'utf8')
    ) as ValidationFixturesFile;
    t.ok(fixturesFile.fixtures.length >= 5, 'need a meaningful fixture suite');

    const softFailures: string[] = [];

    for (const fixture of fixturesFile.fixtures) {
        const actual = pointInWaterIndex(
            sharedIndex!,
            fixture.lon,
            fixture.lat
        );
        const msg = `${fixture.id} (${fixture.lat}, ${fixture.lon}) expected water=${fixture.water} got ${actual}${
            fixture.note ? ` — ${fixture.note}` : ''
        }`;

        if (fixture.critical) {
            t.equal(actual, fixture.water, msg);
        } else if (actual !== fixture.water) {
            softFailures.push(msg);
        } else {
            t.pass(msg);
        }
    }

    if (softFailures.length) {
        t.comment(
            `soft fixture mismatches (non-fatal for dataset refresh):\n${softFailures.join(
                '\n'
            )}`
        );
    }
});

tap.test('dataset refresh regression helpers', async (t) => {
    const fixturesFile = JSON.parse(
        readFileSync(fixturesPath, 'utf8')
    ) as ValidationFixturesFile;

    const critical = fixturesFile.fixtures.filter((f) => f.critical);
    const waterCritical = critical.filter((f) => f.water);
    const landCritical = critical.filter((f) => !f.water);

    t.ok(waterCritical.length >= 2, 'need critical open-water fixtures');
    t.ok(landCritical.length >= 2, 'need critical inland-land fixtures');

    for (const fixture of fixturesFile.fixtures) {
        t.ok(fixture.id.length > 0);
        t.ok(fixture.lat >= -90 && fixture.lat <= 90);
        t.ok(fixture.lon >= -180 && fixture.lon <= 180);
        t.type(fixture.water, 'boolean');
        t.type(fixture.critical, 'boolean');
    }
});
