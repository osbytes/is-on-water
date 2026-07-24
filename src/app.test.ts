import pino from 'pino';
import { initApp } from './app';
import { initConfig } from './config';
import { initWaterLookup } from './is-on-water';

import tap, { Test } from 'tap';
import { Client } from 'undici';
import { AddressInfo } from 'node:net';

const initAppTest = async (t: Test) => {
    await initWaterLookup();
    const config = {
        ...(await initConfig()),
        healthCheckEndpoint: '/some-health-check-endpoint',
        // Ensure tests never require Redis
        redisUrl: undefined,
    };
    const app = await initApp(config, pino({ enabled: false }));
    await app.fastify.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${
        (app.fastify.server.address() as AddressInfo).port
    }`;
    const client = new Client(baseUrl);

    t.teardown(async () => {
        await app.shutdown();
        client.close();
    });

    return {
        config,
        app,
        client,
    };
};

tap.test('app', async (t) => {
    const { config, client } = await initAppTest(t);

    t.test('should return 200 for config health check endpoint', async (t) => {
        const response = await client.request({
            method: 'GET',
            path: config.healthCheckEndpoint,
        });

        t.equal(response.statusCode, 200);
        await response.body.dump();
    });

    t.test('should indicate water for Atlantic point', async (t) => {
        // https://www.latlong.net/c/?lat=20.112682&long=-37.048647
        const lat = 20.112682;
        const lon = -37.048647;
        const response = await client.request({
            method: 'GET',
            path: `/api/water?lat=${lat}&lon=${lon}`,
        });

        t.equal(response.statusCode, 200);
        const body = await response.body.json();
        t.same(body, { lat, lon, water: true });
    });

    t.test('should indicate no water for Nebraska point', async (t) => {
        // https://www.latlong.net/c/?lat=40.292097&long=-98.613164
        const lat = 40.292097;
        const lon = -98.613164;
        const response = await client.request({
            method: 'GET',
            path: `/api/water?lat=${lat}&lon=${lon}`,
        });

        t.equal(response.statusCode, 200);
        const body = await response.body.json();
        t.same(body, { lat, lon, water: false });
    });

    t.test('should accept wrapped batch body on POST', async (t) => {
        const response = await client.request({
            method: 'POST',
            path: '/api/water',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                coordinates: [{ lat: 0, lon: 0 }],
            }),
        });

        t.equal(response.statusCode, 200);
        const body = (await response.body.json()) as {
            results: Array<{ water: boolean; lat: number; lon: number }>;
        };
        t.equal(body.results.length, 1);
        t.equal(body.results[0].lat, 0);
        t.equal(body.results[0].lon, 0);
        t.type(body.results[0].water, 'boolean');
    });

    t.test('should accept bare array batch body on POST', async (t) => {
        const response = await client.request({
            method: 'POST',
            path: '/api/water',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([{ lat: 0, lon: 0 }]),
        });

        t.equal(response.statusCode, 200);
        const body = (await response.body.json()) as {
            results: Array<{ water: boolean; lat: number; lon: number }>;
        };
        t.equal(body.results.length, 1);
        t.equal(body.results[0].lat, 0);
        t.equal(body.results[0].lon, 0);
        t.type(body.results[0].water, 'boolean');
    });

    t.test('should reject invalid latitude with problem details', async (t) => {
        const response = await client.request({
            method: 'GET',
            path: '/api/water?lat=91&lon=0',
        });

        t.equal(response.statusCode, 400);
        t.match(
            String(response.headers['content-type']),
            /application\/problem\+json/
        );
        const body = (await response.body.json()) as {
            type: string;
            title: string;
            status: number;
            detail: string;
        };
        t.equal(body.type, 'about:blank');
        t.equal(body.title, 'Bad Request');
        t.equal(body.status, 400);
        t.type(body.detail, 'string');
    });

    t.test('should serve the landing page', async (t) => {
        const response = await client.request({
            method: 'GET',
            path: '/',
        });

        t.equal(response.statusCode, 200);
        t.match(String(response.headers['cache-control']), /public/);
        t.match(String(response.headers['cache-control']), /max-age=300/);
        t.ok(response.headers.etag);
        t.ok(response.headers['last-modified']);

        const body = await response.body.text();
        t.match(body, /Is On Water/);
        t.match(body, /coord-form/);
        t.match(body, /\/api\/water/);
        t.match(body, /osbytes\.io\/badge/);
        t.match(body, /github\.com\/osbytes\/is-on-water/);
        t.match(body, /OpenStreetMap/);
        t.match(body, /geo-maps/);

        const cached = await client.request({
            method: 'GET',
            path: '/',
            headers: { 'if-none-match': String(response.headers.etag) },
        });
        t.equal(cached.statusCode, 304);
        await cached.body.dump();
    });

    t.test('swagger info version matches package.json', async (t) => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { version } = JSON.parse(
            readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
        ) as { version: string };

        const response = await client.request({
            method: 'GET',
            path: '/documentation/json',
        });

        t.equal(response.statusCode, 200);
        const body = (await response.body.json()) as {
            info: { title: string; version: string };
            paths: Record<string, unknown>;
        };
        t.equal(body.info.title, 'is-on-water');
        t.equal(body.info.version, version);
        t.ok(body.paths['/api/water']);
    });
});
