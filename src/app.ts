import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { FastifyError } from 'fastify';
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
import { isOnWater } from './is-on-water';
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

const isOnWaterResultSchema = z.object({
    water: z.boolean(),
    lat: z.number(),
    lon: z.number(),
});

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
                    'Check whether a geographic coordinate is on water (seas, lakes, and rivers). Water polygons © OpenStreetMap contributors (via geo-maps FlatGeobuf); shoreline accuracy is approximate.',
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
                    return res.status(503).send({ msg: 'Redis unavailable' });
                }
            } catch {
                return res.status(503).send({ msg: 'Redis unavailable' });
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

    app.withTypeProvider<ZodTypeProvider>().route({
        method: 'GET',
        url: '/api/is-on-water',
        schema: {
            querystring: coordinateSchema,
            response: {
                200: isOnWaterResultSchema,
            },
        },
        handler(req, res) {
            res.send(isOnWater(req.query));
        },
    });

    app.withTypeProvider<ZodTypeProvider>().route({
        method: 'POST',
        url: '/api/is-on-water',
        config: {
            // Allow larger batches than the default 1kb body limit
            bodyLimit: 1024 * 100,
        },
        schema: {
            body: z
                .array(coordinateSchema)
                .min(1)
                .max(config.maxBatchSize),
            response: {
                200: z.array(isOnWaterResultSchema),
            },
        },
        handler(req, res) {
            res.send(req.body.map(isOnWater));
        },
    });

    app.setErrorHandler(function (error: FastifyError, req, res) {
        req.log.error(error);

        if (res.sent) return;

        const statusCode = error.statusCode ?? 500;

        if (statusCode === 429) {
            res.status(429).send({ msg: 'Rate limit exceeded' });
            return;
        }

        if (statusCode >= 400 && statusCode < 500) {
            res.status(statusCode).send({
                msg: error.message || 'Bad request',
            });
            return;
        }

        res.status(500).send({ msg: 'Something went wrong' });
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
