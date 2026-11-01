/**
 * Omni-Skill-Proxy - proxy_server （极简本地转发网关）
 *
 * 在 127.0.0.1:8888 启动原生 http 服务：接收下游（DSH 或任意 OpenAI /
 * Anthropic 客户端）请求 -> 强制注入“仅输出代码”的 System Prompt ->
 * 转发到真实上游 -> 流式响应经 stream_stripper 过滤后吐给客户端。
 *
 * Minimal local gateway built on the native http module: takes downstream
 * requests, injects the forced code-only system prompt, forwards them to the
 * real upstream, and pipes SSE responses back through the stripper.
 */

import * as http from 'http';
import { ApiFormat, ProxyConfig, RequestContext } from './types';
import { forwardRequest } from './upstream';
import { injectRules } from './injector';
import { SseStripTransform, stripCompletedText } from './stream_stripper';

/** Which upstream path maps to which wire format. */
export function detectFormat(url: string, body: any): ApiFormat {
  const u = url.toLowerCase();
  if (u.includes('/v1/messages') || u.includes('/messages')) return 'anthropic';
  if (u.includes('/chat/completions') || u.includes('/completions')) return 'openai';
  if (body && Array.isArray(body.messages)) return 'openai';
  if (body && (body.system !== undefined || Array.isArray(body.content))) return 'anthropic';
  return 'openai'; // default assumption: OpenAI-compatible
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Filter a completed (non-streaming) JSON answer in both wire formats. */
function filterJsonBody(raw: Buffer, format: ApiFormat, maxHoldChars: number): Buffer {
  try {
    const obj = JSON.parse(raw.toString('utf8'));
    if (format === 'anthropic') {
      if (Array.isArray(obj?.content)) {
        obj.content = obj.content.map((block: any) => {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            return { ...block, text: stripCompletedText(block.text, maxHoldChars) };
          }
          return block;
        });
      }
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    const message = choice && choice.message;
    if (message && typeof message.content === 'string') {
      message.content = stripCompletedText(message.content, maxHoldChars);
    }
    return Buffer.from(JSON.stringify(obj), 'utf8');
  } catch {
    return raw; // not JSON: pass through untouched
  }
}

/** Response headers we forward back to the client (drop hop-by-hop). */
function forwardedHeaders(upstreamHeaders: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const k = key.toLowerCase();
    if (['transfer-encoding', 'connection', 'keep-alive', 'content-length', 'content-encoding'].includes(k)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface StartOptions {
  config: ProxyConfig;
  /** Live system-prompt rules injected into every request (hot-reloadable). */
  getSystemText: () => string;
}

export function startProxy({ config, getSystemText }: StartOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const log = (msg: string) =>
      console.log(`[proxy] ${req.method} ${req.url} - ${msg} (${Date.now() - started}ms)`);

    try {
      // Health probe for the demo / any orchestrator.
      if ((req.url || '').split('?')[0] === '/__health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'omni-skill-proxy', version: '1.0.0' }));
        return;
      }

      const rawBody = await readBody(req);
      let bodyObj: any = undefined;
      if (rawBody.length > 0) {
        try {
          bodyObj = JSON.parse(rawBody.toString('utf8'));
        } catch {
          bodyObj = undefined; // upstream may accept non-JSON; forward as-is
        }
      }

      const format = detectFormat(req.url || '/', bodyObj);
      const streaming = !!(bodyObj && bodyObj.stream === true);

      // 1) 强制注入系统提示 / force-inject the code-only system prompt
      let outBody: Buffer = rawBody;
      if (config.inject && bodyObj !== undefined) {
        outBody = Buffer.from(JSON.stringify(injectRules(bodyObj, format, getSystemText())), 'utf8');
      }

      const ctx: RequestContext = {
        url: req.url || '/',
        method: req.method || 'POST',
        format,
        streaming,
      };

      // 2) 转发上游 / forward upstream
      let result;
      try {
        result = await forwardRequest(config, ctx, req.headers, outBody);
      } catch (err) {
        log(`upstream error: ${(err as Error).message}`);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'omni-skill-proxy upstream failure', message: (err as Error).message }));
        return;
      }

      const isSse = (result.headers['content-type'] || '').includes('text/event-stream');
      const useStripper = config.strip && (streaming || isSse);

      // 3a) 流式：SSE 过滤后透传 / streaming: pipe through the stripper
      if (useStripper) {
        const stripper = new SseStripTransform(format, config.maxHoldChars);
        log(`streaming ${format} -> stripper active`);
        res.writeHead(result.statusCode, forwardedHeaders(result.headers));
        result.res.on('error', (err) => {
          console.error(`[proxy] upstream stream error: ${err.message}`);
          res.destroy();
        });
        result.res.pipe(stripper).pipe(res);
        return;
      }

      // 3b) 非流式：整个正文过滤后返回 / non-streaming: filter the full body
      const chunks: Buffer[] = [];
      result.res.on('data', (c: Buffer) => chunks.push(c));
      result.res.on('end', () => {
        // 显式标注：Buffer.concat 推断为 Buffer<ArrayBuffer>，需放宽到裸 Buffer（ArrayBufferLike）
        let payload: Buffer = Buffer.concat(chunks);
        if (config.strip && format !== 'unknown' && !isSse) {
          payload = filterJsonBody(payload, format, config.maxHoldChars);
        }
        const headers = forwardedHeaders(result.headers);
        headers['content-length'] = Buffer.byteLength(payload);
        log(`done (${result.statusCode})`);
        res.writeHead(result.statusCode, headers);
        res.end(payload);
      });
      result.res.on('error', (err) => {
        console.error(`[proxy] upstream read error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    } catch (err) {
      console.error(`[proxy] internal error: ${(err as Error).stack || (err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'omni-skill-proxy internal error' }));
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[proxy] port ${config.port} already in use; set PORT=... to change it`);
      process.exit(1);
    } else {
      console.error(`[proxy] server error: ${err.message}`);
    }
  });

  server.listen(config.port, config.host, () => {
    const W = 56; // inner width, fixed so the box can never misalign
    const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const line = (content: string) => `  ║ ${content.padEnd(W - 2).slice(0, W - 2)}║`;
    console.log(`  ╔${'═'.repeat(W)}╗`);
    console.log(line('Omni-Skill-Proxy v1.0.0 :: GATEWAY ONLINE'));
    console.log(`  ╠${'═'.repeat(W)}╣`);
    console.log(line(`listen   http://${config.host}:${config.port}`));
    console.log(line(`upstream ${trunc(config.upstreamBaseUrl || '(not configured)', 44)}`));
    console.log(line(`inject   ${config.inject ? 'ON ' : 'OFF'}     strip   ${config.strip ? 'ON ' : 'OFF'}`));
    console.log(`  ╚${'═'.repeat(W)}╝`);
    console.log(`[proxy] ready - point your client base URL at http://${config.host}:${config.port}`);
  });

  return server;
}
