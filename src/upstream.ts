/**
 * Omni-Skill-Proxy - upstream client
 *
 * 只用 Node 原生 http / https 模块把改写后的请求转发到真实上游。
 * Only Node's built-in http / https modules are used to reach the upstream.
 */

import * as http from 'http';
import * as https from 'https';
import { ApiFormat, ProxyConfig, RequestContext } from './types';

/** Hop-by-hop headers that must never be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export interface UpstreamResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  res: http.IncomingMessage;
}

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
};

/**
 * Send the (already rewritten) body upstream and return the raw response so
 * callers can either buffer it or pipe it through the SSE stripper.
 */
export function forwardRequest(
  cfg: ProxyConfig,
  ctx: RequestContext,
  clientHeaders: http.IncomingHttpHeaders,
  body: Buffer,
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    if (!cfg.upstreamBaseUrl) {
      reject(new Error('UPSTREAM_BASE_URL is not configured'));
      return;
    }

    let base: URL;
    try {
      base = new URL(cfg.upstreamBaseUrl);
    } catch (err) {
      reject(new Error(`invalid UPSTREAM_BASE_URL: ${(err as Error).message}`));
      return;
    }
    const transport = base.protocol === 'https:' ? https : http;

    const path = ctx.url.startsWith('/') ? ctx.url : `/${ctx.url}`;
    const headers: http.OutgoingHttpHeaders = {};

    for (const [key, value] of Object.entries(clientHeaders)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers['host'] = base.host;
    headers['content-length'] = Buffer.byteLength(body);

    if (cfg.upstreamApiKey) {
      if (ctx.format === 'anthropic') {
        headers['x-api-key'] = cfg.upstreamApiKey;
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${cfg.upstreamApiKey}`;
      }
    }
    Object.assign(headers, cfg.extraHeaders);

    const req = transport.request(
      {
        method: ctx.method,
        host: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: `${base.pathname.replace(/\/+$/, '')}${path}`,
        headers,
        agent: base.protocol === 'https:' ? agents.https : agents.http,
      },
      (res) => {
        resolve({ statusCode: res.statusCode || 502, headers: res.headers, res });
      },
    );

    req.on('error', reject);
    req.end(body);
  });
}
