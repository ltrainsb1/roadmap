import type { FastifyRequest } from 'fastify';

// An invite link's token is the whole credential and sits in the path, so it must never reach the logs.
const INVITE_TOKEN = /^(\/api\/invites\/)[^/?#]+/i;

/** The request URL as it may be logged: an invite token in the path is replaced. */
export const redactUrl = (url: string): string => url.replace(INVITE_TOKEN, '$1[redacted]');

/** What Fastify's own request serializer logs, with the URL redacted. */
export function serializeRequest(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
