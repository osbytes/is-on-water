import pino from "pino";

export type Config = {
    shutdownTimeoutMs: number;
    port: number;
    healthCheckEndpoint: string;
    env: Env;
    logLevel: pino.Level;
    /** When set, rate limiting uses Redis; otherwise an in-memory store. */
    redisUrl?: string;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    maxBatchSize: number;
    trustProxy: boolean;
    /** `WATER_LAYERS` spec, e.g. "oceans:high,lakes:medium". Empty uses the registry default. */
    waterLayers?: string;
    /** Override the bundled layer registry to add self-hosted artifacts. */
    layerRegistryPath?: string;
    /** Where downloaded (non-bundled) layers are cached between restarts. */
    layerCacheDir?: string;
}

export const initConfig = async (): Promise<Config> => {
    const redisUrl = process.env.REDIS_URL?.trim();
    const waterLayers = process.env.WATER_LAYERS?.trim();
    const layerRegistryPath = process.env.WATER_LAYERS_REGISTRY?.trim();
    const layerCacheDir = process.env.WATER_LAYER_CACHE_DIR?.trim();

    return {
        shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000"),
        port: parseInt(process.env.PORT || "3000"),
        healthCheckEndpoint: process.env.HEALTH_CHECK_ENDPOINT || "/health",
        env: getEnv(),
        logLevel: process.env.LOG_LEVEL?.toLowerCase() as pino.Level|undefined || "info",
        redisUrl: redisUrl || undefined,
        rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
        rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || "100"),
        maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || "500"),
        trustProxy: (process.env.TRUST_PROXY?.toLowerCase() || "true") === "true",
        waterLayers: waterLayers || undefined,
        layerRegistryPath: layerRegistryPath || undefined,
        layerCacheDir: layerCacheDir || undefined,
    }
}

export enum Env {
    Dev,
    Test,
    Prod,
}

const getEnv = (): Env => {
    switch (process.env.NODE_ENV?.toLowerCase()) {
        case "development": return Env.Dev
        case "test": return Env.Test
        case "production": return Env.Prod
        default: return Env.Dev
    }
}
