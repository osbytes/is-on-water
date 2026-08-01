import tap from 'tap';
import {
    LayerSelectionError,
    findArtifact,
    formatSelection,
    parseLayerSelection,
    type LayerRegistry,
} from './layers';

const artifact = (
    feature: string,
    precision: 'low' | 'medium' | 'high' | 'full'
) => ({
    feature,
    precision,
    delivery: 'bundled' as const,
    file: `layers/${feature}-${precision}.fgb.gz`,
    sha256: 'deadbeef',
    source: 'test',
    license: 'ODbL',
});

const registry: LayerRegistry = {
    schemaVersion: 1,
    defaultSelection: 'oceans:medium,lakes:medium',
    features: {
        oceans: { defaultPrecision: 'medium', description: 'Oceans and seas' },
        lakes: { defaultPrecision: 'medium', description: 'Inland lakes' },
    },
    artifacts: [
        artifact('oceans', 'low'),
        artifact('oceans', 'medium'),
        artifact('oceans', 'full'),
        artifact('lakes', 'medium'),
    ],
};

const ids = (spec?: string) =>
    parseLayerSelection(spec, registry).map(formatSelection);

tap.test('falls back to the registry default', async (t) => {
    t.same(ids(undefined), ['oceans:medium', 'lakes:medium']);
    t.same(ids(''), ['oceans:medium', 'lakes:medium']);
    t.same(ids('   '), ['oceans:medium', 'lakes:medium']);
});

tap.test('a bare feature uses its default precision', async (t) => {
    t.same(ids('oceans'), ['oceans:medium']);
    t.same(ids('oceans,lakes'), ['oceans:medium', 'lakes:medium']);
});

tap.test('explicit precisions are honoured', async (t) => {
    t.same(ids('oceans:full'), ['oceans:full']);
    t.same(ids('oceans:low,lakes:medium'), ['oceans:low', 'lakes:medium']);
});

tap.test('"all" selects every feature at its default', async (t) => {
    t.same(ids('all'), ['oceans:medium', 'lakes:medium']);
});

tap.test('duplicate features collapse to the highest precision', async (t) => {
    t.same(ids('oceans:low,oceans:full'), ['oceans:full']);
    t.same(ids('oceans:full,oceans:low'), ['oceans:full']);
    t.same(ids('all,oceans:full'), ['oceans:full', 'lakes:medium']);
});

tap.test('selection order follows the registry, not the caller', async (t) => {
    t.same(ids('lakes,oceans'), ['oceans:medium', 'lakes:medium']);
});

tap.test('whitespace and casing are tolerated', async (t) => {
    t.same(ids(' Oceans : Full '.replace(/\s+/g, '')), ['oceans:full']);
    t.same(ids('OCEANS,lakes'), ['oceans:medium', 'lakes:medium']);
    t.same(ids('oceans, ,lakes'), ['oceans:medium', 'lakes:medium']);
});

tap.test('unknown features are rejected with guidance', async (t) => {
    const err = t.throws(
        () => parseLayerSelection('rivers', registry),
        LayerSelectionError
    ) as Error;
    t.match(err.message, /Unknown water feature "rivers"/);
    t.match(err.message, /oceans, lakes/, 'lists the known features');
});

tap.test('unknown precisions are rejected with guidance', async (t) => {
    const err = t.throws(
        () => parseLayerSelection('oceans:ultra', registry),
        LayerSelectionError
    ) as Error;
    t.match(err.message, /Unknown precision "ultra"/);
    t.match(err.message, /low, medium, high, full/, 'lists valid precisions');
});

tap.test('unpublished combinations are rejected with guidance', async (t) => {
    const err = t.throws(
        () => parseLayerSelection('lakes:full', registry),
        LayerSelectionError
    ) as Error;
    t.match(err.message, /No artifact published for "lakes:full"/);
    t.match(err.message, /medium/, 'lists what is available for lakes');
});

tap.test('malformed entries are rejected', async (t) => {
    t.throws(
        () => parseLayerSelection('oceans:medium:extra', registry),
        LayerSelectionError
    );
});

tap.test('findArtifact resolves a selection to its artifact', async (t) => {
    const found = findArtifact(registry, {
        feature: 'oceans',
        precision: 'full',
    });
    t.equal(found?.file, 'layers/oceans-full.fgb.gz');
    t.notOk(findArtifact(registry, { feature: 'lakes', precision: 'full' }));
});
