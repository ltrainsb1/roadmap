import type { FastifyRequest } from 'fastify';

// An invite link's token is the whole credential and sits in the path, so it must never reach the logs.
const INVITE_TOKEN = /^(\/api\/invites\/)[^/?#]+/i;

// A snapshot's link id is half of what opens it; the log keeps its first 6 characters, enough to tell links apart.
const SNAPSHOT_LINK = /^(\/api\/snapshots\/)([^/?#]{0,6})[^/?#]*/i;

// A calendar feed's token is the whole credential; the log keeps its first 6 characters, as for snapshot links.
const CALENDAR_TOKEN = /^(\/api\/calendar\/)([^/?#.]{0,6})[^/?#.]*/i;

// An unsubscribe link's token (in the query string) is the whole credential for turning someone's emails off.
const UNSUBSCRIBE_TOKEN = /^(\/api\/email\/unsubscribe\?(?:[^#]*&)?t=)[^&#]*/i;

/** The request URL as it may be logged: invite and unsubscribe tokens are replaced; snapshot link ids and feed tokens are cut short. */
export const redactUrl = (url: string): string =>
  url.replace(INVITE_TOKEN, '$1[redacted]').replace(SNAPSHOT_LINK, '$1$2…').replace(CALENDAR_TOKEN, '$1$2…').replace(UNSUBSCRIBE_TOKEN, '$1[redacted]');

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
