import type { FastifyRequest } from 'fastify';

// An invite link's token is the whole credential and sits in the path, so it must never reach the logs.
const INVITE_TOKEN = /^(\/api\/invites\/)[^/?#]+/i;

// A snapshot's link id is half of what opens it; the log keeps its first 6 characters, enough to tell links apart.
const SNAPSHOT_LINK = /^(\/api\/snapshots\/)([^/?#]{0,6})[^/?#]*/i;

/** The request URL as it may be logged: an invite token is replaced and a snapshot link id is cut short. */
export const redactUrl = (url: string): string =>
  url.replace(INVITE_TOKEN, '$1[redacted]').replace(SNAPSHOT_LINK, '$1$2…');

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
