import tap from 'tap';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
    dataDir,
    fixturesPath,
    loadRegistry,
    pointInFgb,
    readFgbBytes,
    registryPath,
} from './waterbodies-index';
import { PRECISION_ORDER, parseLayerSelection } from './layers';
import { initWaterLookup, isOnWater } from './is-on-water';

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

const GITHUB_SOFT_LIMIT = 95 * 1024 * 1024;

tap.before(async () => {
    await initWaterLookup();
});

tap.test('registry and fixtures exist', async (t) => {
    t.ok(existsSync(registryPath), `missing ${registryPath}`);
    t.ok(existsSync(fixturesPath), `missing ${fixturesPath}`);
});

tap.test('registry describes usable artifacts', async (t) => {
    const registry = loadRegistry();

    t.equal(registry.schemaVersion, 1);
    t.ok(registry.artifacts.length >= 2, 'expected at least oceans and lakes');
    t.ok(registry.features.oceans, 'oceans feature is declared');
    t.ok(registry.features.lakes, 'lakes feature is declared');

    for (const artifact of registry.artifacts) {
        const id = `${artifact.feature}:${artifact.precision}`;
        t.ok(registry.features[artifact.feature], `${id} names a known feature`);
        t.ok(
            (PRECISION_ORDER as readonly string[]).includes(artifact.precision),
            `${id} uses a known precision`
        );
        t.ok(artifact.license, `${id} declares a license`);
        t.ok(artifact.sha256, `${id} declares a checksum`);

        if (artifact.delivery === 'bundled') {
            t.ok(artifact.file, `${id} bundled artifact declares a file`);
        } else {
            t.ok(artifact.url, `${id} remote artifact declares a url`);
        }
    }
});

tap.test('bundled artifacts match their registry entries', async (t) => {
    const registry = loadRegistry();
    const bundled = registry.artifacts.filter((a) => a.delivery === 'bundled');
    t.ok(bundled.length >= 2, 'expected bundled oceans and lakes artifacts');

    for (const artifact of bundled) {
        const id = `${artifact.feature}:${artifact.precision}`;
        const filePath = path.join(dataDir, artifact.file as string);
        t.ok(existsSync(filePath), `${id} file exists at ${filePath}`);

        const gzSize = statSync(filePath).size;
        t.equal(artifact.gzipBytes, gzSize, `${id} gzip size matches`);
        t.equal(
            artifact.sha256,
            sha256(readFileSync(filePath)),
            `${id} checksum matches`
        );
        t.ok(
            gzSize < GITHUB_SOFT_LIMIT,
            `${id} stays under the GitHub blob limit`
        );

        const bytes = readFgbBytes(filePath);
        t.equal(artifact.bytes, bytes.byteLength, `${id} raw size matches`);
        t.ok(bytes.byteLength > 1_000_000, `${id} is non-trivial in size`);
        t.ok((artifact.featureCount ?? 0) > 1000, `${id} has many features`);
    }
});

tap.test('default selection resolves to the bundled layers', async (t) => {
    const registry = loadRegistry();
    const selections = parseLayerSelection(undefined, registry);

    t.same(
        selections.map((s) => `${s.feature}:${s.precision}`),
        ['oceans:medium', 'lakes:medium']
    );
});

tap.test('validation fixtures against enabled layers', async (t) => {
    const fixturesFile = JSON.parse(
        readFileSync(fixturesPath, 'utf8')
    ) as ValidationFixturesFile;
    t.ok(fixturesFile.fixtures.length >= 5, 'need a meaningful fixture suite');

    const softFailures: string[] = [];

    for (const fixture of fixturesFile.fixtures) {
        const result = await isOnWater({
            lat: fixture.lat,
            lon: fixture.lon,
        });
        const msg = `${fixture.id} (${fixture.lat}, ${fixture.lon}) expected water=${fixture.water} got ${result.water}${
            fixture.note ? ` — ${fixture.note}` : ''
        }`;

        if (fixture.critical) {
            t.equal(result.water, fixture.water, msg);
            if (result.water) {
                t.ok(result.layer, `${fixture.id} reports the matching layer`);
            } else {
                t.equal(result.layer, null, `${fixture.id} reports no layer`);
            }
        } else if (result.water !== fixture.water) {
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

tap.test('layers are queried independently', async (t) => {
    const registry = loadRegistry();
    const oceans = registry.artifacts.find(
        (a) => a.feature === 'oceans' && a.delivery === 'bundled'
    );
    const lakes = registry.artifacts.find(
        (a) => a.feature === 'lakes' && a.delivery === 'bundled'
    );
    t.ok(oceans && lakes, 'both bundled artifacts are present');

    const oceanBytes = readFgbBytes(path.join(dataDir, oceans!.file as string));
    const lakeBytes = readFgbBytes(path.join(dataDir, lakes!.file as string));

    // Lake Superior is inland, so it must come from lakes and not from oceans.
    t.notOk(
        await pointInFgb(oceanBytes, -87.5, 47.7),
        'oceans layer excludes Lake Superior'
    );
    t.ok(
        await pointInFgb(lakeBytes, -87.5, 47.7),
        'lakes layer includes Lake Superior'
    );

    // Mid-Atlantic is the reverse.
    t.ok(
        await pointInFgb(oceanBytes, -37.048647, 20.112682),
        'oceans layer includes the mid-Atlantic'
    );
    t.notOk(
        await pointInFgb(lakeBytes, -37.048647, 20.112682),
        'lakes layer excludes the mid-Atlantic'
    );
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
