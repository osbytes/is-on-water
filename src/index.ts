import { otlpShutdown } from './telemetry';
import { initApp } from './app';
import { Env, initConfig } from './config';
import { initLogging } from './logging';
import { initWaterLookup } from './is-on-water';
import gracefulShutdown from 'http-graceful-shutdown';

const main = async () => {
    const config = await initConfig();
    const logger = await initLogging(config);
    logger.info('Loading waterbodies FlatGeobuf…');
    await initWaterLookup();
    logger.info('Waterbodies index ready');
    const app = await initApp(config, logger);

    await app.fastify.listen({
        port: config.port,
        host: '0.0.0.0',
    });

    gracefulShutdown(app.fastify.server, {
        timeout: config.shutdownTimeoutMs,
        development: config.env !== Env.Prod,
        preShutdown: async (signal) => {
            logger.info({ signal }, 'Shutdown signal received');
        },
        onShutdown: async () => {
            await app.shutdown();
            await otlpShutdown();
        },
        finally: () => {
            logger.info('Shutdown complete');
        },
    });
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
