import pino from 'pino';
import {
    LogController,
    type FastifyReply,
    type FastifyRequest,
} from 'fastify';
import { Config } from './config';

/** Leaner req/res shapes for request logs (avoids verbose Fastify defaults). */
export const requestLogSerializers = {
    req(req: FastifyRequest) {
        return {
            method: req.method,
            url: req.url,
            host: req.host,
            ip: req.ip,
        };
    },
    res(reply: FastifyReply) {
        return {
            status: reply.statusCode,
        };
    },
};

type AppLogControllerOptions = ConstructorParameters<typeof LogController>[0];

/**
 * Request lifecycle logs with clearer field names:
 * - reqId → id
 * - responseTime → duration
 * - res.statusCode → res.status (via serializers)
 */
export class AppLogController extends LogController {
    constructor(options: AppLogControllerOptions = {}) {
        super({
            ...options,
            requestIdLogLabel: options?.requestIdLogLabel ?? 'id',
        });
    }

    override requestCompleted(
        error: Error | null,
        request: FastifyRequest,
        reply: FastifyReply,
        _metadata?: Record<string, unknown>
    ): void {
        if (this.isLogDisabled(request)) return;

        if (error) {
            reply.log.error(
                { res: reply, err: error, duration: reply.elapsedTime },
                'request errored'
            );
            return;
        }

        reply.log.info(
            { res: reply, duration: reply.elapsedTime },
            'request completed'
        );
    }

    override serializerError(
        error: Error,
        request: FastifyRequest,
        reply: FastifyReply,
        metadata: { statusCode: number }
    ): void {
        if (this.isLogDisabled(request)) return;

        reply.log.error(
            { err: error, status: metadata.statusCode },
            'The serializer for the given status code failed'
        );
    }

    override serviceUnavailable(
        logger: { info: (obj: object, msg?: string) => void },
        _server: unknown
    ): void {
        logger.info(
            { res: { status: 503 } },
            'request aborted - refusing to accept new requests as server is closing'
        );
    }
}

export const initLogging = async (config: Config): Promise<pino.Logger> => {
    return pino({
        level: config.logLevel,
        serializers: {
            req: requestLogSerializers.req,
            res: requestLogSerializers.res,
            err: pino.stdSerializers.err,
        },
    });
};
