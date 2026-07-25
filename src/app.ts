import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyError, FastifyReply } from 'fastify';
import pino from 'pino';
import helmet from '@fastify/helmet';
import compression from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Redis from 'ioredis';
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
    jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import z from 'zod';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';

import { Config } from './config';
import { getLoadedLayers, isOnWater } from './is-on-water';
import { AppLogController } from './logging';

const { name: packageName, version: packageVersion } = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
) as { name: string; version: string };

declare module 'fastify' {
    interface FastifyRequest {
        abortSignal: AbortSignal;
    }
}

const coordinateSchema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
});

const waterResultSchema = z.object({
    water: z.boolean(),
    lat: z.number(),
    lon: z.number(),
    layer: z
        .string()
        .nullable()
        .describe(
            'Which enabled layer matched (e.g. "lakes:medium"), or null when the coordinate is not on water in any enabled layer.'
        ),
});

const layerSummarySchema = z.object({
    id: z.string(),
    feature: z.string(),
    precision: z.string(),
    delivery: z.string(),
    scope: z.string().optional(),
    license: z.string(),
    attribution: z.string().optional(),
    citation: z.string().optional(),
    simplifyToleranceDeg: z.string().nullish(),
    minAreaKm2: z.string().nullish(),
    featureCount: z.number().optional(),
});

const layersResponseSchema = z.object({
    layers: z.array(layerSummarySchema),
});

const batchRequestSchema = (maxBatchSize: number) =>
    z.union([
        z.array(coordinateSchema).min(1).max(maxBatchSize),
        z.object({
            coordinates: z
                .array(coordinateSchema)
                .min(1)
                .max(maxBatchSize),
        }),
    ]);

const batchResponseSchema = z.object({
    results: z.array(waterResultSchema),
});

const problemDetailsSchema = z.object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    detail: z.string(),
});

const PROBLEM_JSON = 'application/problem+json';

const httpTitle = (statusCode: number): string => {
    switch (statusCode) {
        case 400:
            return 'Bad Request';
        case 404:
            return 'Not Found';
        case 413:
            return 'Payload Too Large';
        case 429:
            return 'Too Many Requests';
        case 503:
            return 'Service Unavailable';
        default:
            return statusCode >= 500 ? 'Internal Server Error' : 'Error';
    }
};

const sendProblem = (
    res: FastifyReply,
    statusCode: number,
    detail: string
) => {
    return res
        .status(statusCode)
        .type(PROBLEM_JSON)
        .send({
            type: 'about:blank',
            title: httpTitle(statusCode),
            status: statusCode,
            detail,
        });
};

const normalizeBatchCoordinates = (
    body:
        | Array<{ lat: number; lon: number }>
        | { coordinates: Array<{ lat: number; lon: number }> }
) => (Array.isArray(body) ? body : body.coordinates);

export const initApp = async (config: Config, logger: pino.Logger) => {
    const redis = config.redisUrl
        ? new Redis(config.redisUrl, {
              connectTimeout: 500,
              maxRetriesPerRequest: 1,
              lazyConnect: true,
          })
        : undefined;

    if (redis) {
        await redis.connect();
        logger.info('Rate limiting store: Redis');
    } else {
        logger.info('Rate limiting store: in-memory');
    }

    const app = Fastify({
        loggerInstance: logger,
        logController: new AppLogController(),
        trustProxy: config.trustProxy,
        bodyLimit: 1024,
        genReqId: () => randomUUID(),
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(fastifySwagger, {
        openapi: {
            info: {
                title: packageName,
                description:
                    'Check whether a geographic coordinate is on water. Coverage is configurable per deployment: each instance enables a set of water layers, and GET /api/layers reports exactly which ones are active. The default set is oceans and seas (OSM coastline water polygons, © OpenStreetMap contributors, ODbL) plus inland lakes and reservoirs ≥ 2 km² (HydroLAKES; Messager et al. 2016, CC-BY 4.0). Shoreline accuracy is approximate, and a false result means "not in any enabled layer" rather than a guarantee of dry land.',
                version: packageVersion,
            },
            servers: [],
        },
        transform: jsonSchemaTransform,
    });

    await app.register(helmet, {
        contentSecurityPolicy: {
            directives: {
                'script-src': ["'self'", "'unsafe-inline'"],
                'style-src': [
                    "'self'",
                    "'unsafe-inline'",
                    'https://fonts.googleapis.com',
                ],
                'font-src': ["'self'", 'https://fonts.gstatic.com'],
                'img-src': [
                    "'self'",
                    'data:',
                    'https://osbytes.io',
                    'https://www.osbytes.io',
                    'https://railway.app',
                ],
                'connect-src': ["'self'"],
            },
        },
    });
    await app.register(compression);
    await app.register(fastifySwaggerUI, {
        routePrefix: '/documentation',
    });

    await app.register(rateLimit, {
        global: true,
        max: config.rateLimitMax,
        timeWindow: config.rateLimitWindowMs,
        redis,
        nameSpace: 'is-on-water-rl:',
        allowList: (req) => {
            const pathOnly = req.url.split('?')[0];
            return (
                pathOnly === config.healthCheckEndpoint ||
                pathOnly === '/documentation' ||
                pathOnly.startsWith('/documentation/')
            );
        },
    });

    await app.register(fastifyStatic, {
        root: path.join(__dirname, 'public'),
        wildcard: false,
        index: false,
        // Landing HTML changes only on deploy; short TTL + ETag/Last-Modified.
        maxAge: '5 minutes',
        etag: true,
        lastModified: true,
        cacheControl: true,
    });

    await app.after();

    app.addHook('onRequest', async (req) => {
        const ac = new AbortController();
        req.abortSignal = ac.signal;

        req.raw.on('close', () => {
            if (req.raw.destroyed) {
                ac.abort();
            }
        });
    });

    app.get(config.healthCheckEndpoint, async (_req, res) => {
        if (redis) {
            try {
                const pong = await redis.ping();
                if (pong !== 'PONG') {
                    return sendProblem(res, 503, 'Redis unavailable');
                }
            } catch {
                return sendProblem(res, 503, 'Redis unavailable');
            }
        }
        res.status(200).send();
    });

    app.get('/', (_req, res) => {
        return res.sendFile('index.html', {
            maxAge: '5 minutes',
            etag: true,
            lastModified: true,
            cacheControl: true,
        });
    });

    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.route({
        method: 'GET',
        url: '/api/water',
        schema: {
            querystring: coordinateSchema,
            response: {
                200: waterResultSchema,
                400: problemDetailsSchema,
            },
        },
        async handler(req, res) {
            res.send(await isOnWater(req.query));
        },
    });

    typed.route({
        method: 'POST',
        url: '/api/water',
        config: {
            // Allow larger batches than the default 1kb body limit
            bodyLimit: 1024 * 100,
        },
        schema: {
            body: batchRequestSchema(config.maxBatchSize),
            response: {
                200: batchResponseSchema,
                400: problemDetailsSchema,
            },
        },
        async handler(req, res) {
            const coordinates = normalizeBatchCoordinates(req.body);
            const results = [];
            for (const coordinate of coordinates) {
                results.push(await isOnWater(coordinate));
            }
            res.send({ results });
        },
    });

    typed.route({
        method: 'GET',
        url: '/api/layers',
        schema: {
            response: {
                200: layersResponseSchema,
            },
        },
        handler(_req, res) {
            res.send({ layers: getLoadedLayers() });
        },
    });

    app.setErrorHandler(function (error: FastifyError, req, res) {
        req.log.error(error);

        if (res.sent) return;

        const statusCode = error.statusCode ?? 500;

        if (statusCode === 429) {
            sendProblem(res, 429, 'Rate limit exceeded');
            return;
        }

        if (statusCode >= 400 && statusCode < 500) {
            sendProblem(res, statusCode, error.message || 'Bad request');
            return;
        }

        sendProblem(res, 500, 'Something went wrong');
    });

    await app.ready();

    return {
        fastify: app,
        shutdown: async () => {
            await app.close();
            if (redis) {
                await redis.quit();
            }
        },
    };
};
