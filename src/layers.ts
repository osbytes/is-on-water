/**
 * Layer registry and the `WATER_LAYERS` selection syntax.
 *
 * Coverage is addressed as `{feature}:{precision}` pairs, e.g. `oceans:high`.
 * A feature is a kind of water (oceans, lakes, ...); a precision is how much
 * geometric detail and how many small features that artifact carries.
 */

export const PRECISION_ORDER = ['low', 'medium', 'high', 'full'] as const;

export type Precision = (typeof PRECISION_ORDER)[number];

/**
 * How an artifact reaches the process:
 * - `bundled`  ships in the repo/image under the data directory
 * - `download` fetched once at boot into the cache dir, checksum-verified
 * - `range`    never fully downloaded; queried in place via HTTP range requests
 */
export type Delivery = 'bundled' | 'download' | 'range';

export type LayerArtifact = {
    feature: string;
    precision: Precision;
    delivery: Delivery;
    /** Path relative to the data directory. Required when delivery is `bundled`. */
    file?: string;
    /** Required when delivery is `download` or `range`. */
    url?: string;
    /** SHA-256 of the delivered file. Required for `download`. */
    sha256?: string;
    bytes?: number;
    gzipBytes?: number;
    featureCount?: number;
    simplifyToleranceDeg?: string | null;
    minAreaKm2?: string | null;
    source: string;
    license: string;
    attribution?: string;
    scope?: string;
    citation?: string;
};

export type FeatureDefinition = {
    defaultPrecision: Precision;
    description: string;
};

export type LayerRegistry = {
    schemaVersion: number;
    generatedAt?: string;
    builder?: string;
    defaultSelection: string;
    features: Record<string, FeatureDefinition>;
    sources?: Array<Record<string, unknown>>;
    artifacts: LayerArtifact[];
};

export type LayerSelection = {
    feature: string;
    precision: Precision;
};

export class LayerSelectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LayerSelectionError';
        // Transpilers that downlevel classes break `extends Error`, which would
        // make instanceof checks against this type silently fail.
        Object.setPrototypeOf(this, LayerSelectionError.prototype);
    }
}

const precisionRank = (precision: Precision): number =>
    PRECISION_ORDER.indexOf(precision);

const isPrecision = (value: string): value is Precision =>
    (PRECISION_ORDER as readonly string[]).includes(value);

export const formatSelection = (selection: LayerSelection): string =>
    `${selection.feature}:${selection.precision}`;

export const findArtifact = (
    registry: LayerRegistry,
    selection: LayerSelection
): LayerArtifact | undefined =>
    registry.artifacts.find(
        (a) =>
            a.feature === selection.feature &&
            a.precision === selection.precision
    );

const availablePrecisions = (
    registry: LayerRegistry,
    feature: string
): Precision[] =>
    registry.artifacts
        .filter((a) => a.feature === feature)
        .map((a) => a.precision)
        .sort((a, b) => precisionRank(a) - precisionRank(b));

/**
 * Parse a `WATER_LAYERS` spec into a deduplicated selection.
 *
 * Accepts `oceans:high,lakes:medium`, a bare `oceans` (that feature's default
 * precision), or `all` (every known feature at its default precision). A
 * feature named more than once collapses to its highest requested precision,
 * so `oceans:low,oceans:full` yields `oceans:full`.
 *
 * Selections are returned in registry feature order rather than the order the
 * caller wrote them, which keeps lookups short-circuiting on the broadest
 * layer first.
 */
export const parseLayerSelection = (
    spec: string | undefined,
    registry: LayerRegistry
): LayerSelection[] => {
    const raw = (spec ?? '').trim() || registry.defaultSelection;
    const knownFeatures = Object.keys(registry.features);

    const entries = raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

    if (entries.length === 0) {
        throw new LayerSelectionError(
            `WATER_LAYERS is empty. Use "all" or a list like "${registry.defaultSelection}".`
        );
    }

    const expanded: LayerSelection[] = [];

    for (const entry of entries) {
        if (entry === 'all') {
            for (const feature of knownFeatures) {
                expanded.push({
                    feature,
                    precision: registry.features[feature].defaultPrecision,
                });
            }
            continue;
        }

        const parts = entry.split(':');
        if (parts.length > 2) {
            throw new LayerSelectionError(
                `Invalid WATER_LAYERS entry "${entry}". Expected "feature" or "feature:precision".`
            );
        }

        const [feature, precisionPart] = parts;
        const definition = registry.features[feature];
        if (!definition) {
            throw new LayerSelectionError(
                `Unknown water feature "${feature}". Known features: ${knownFeatures.join(', ')}.`
            );
        }

        const precision = precisionPart ?? definition.defaultPrecision;
        if (!isPrecision(precision)) {
            throw new LayerSelectionError(
                `Unknown precision "${precisionPart}" for feature "${feature}". Valid precisions: ${PRECISION_ORDER.join(', ')}.`
            );
        }

        expanded.push({ feature, precision });
    }

    // Collapse duplicates, keeping the most detailed request for each feature.
    const highest = new Map<string, Precision>();
    for (const { feature, precision } of expanded) {
        const current = highest.get(feature);
        if (!current || precisionRank(precision) > precisionRank(current)) {
            highest.set(feature, precision);
        }
    }

    const selections = knownFeatures
        .filter((feature) => highest.has(feature))
        .map((feature) => ({
            feature,
            precision: highest.get(feature) as Precision,
        }));

    for (const selection of selections) {
        if (findArtifact(registry, selection)) continue;
        const available = availablePrecisions(registry, selection.feature);
        throw new LayerSelectionError(
            available.length
                ? `No artifact published for "${formatSelection(selection)}". Available precisions for "${selection.feature}": ${available.join(', ')}.`
                : `No artifacts published for feature "${selection.feature}".`
        );
    }

    return selections;
};
