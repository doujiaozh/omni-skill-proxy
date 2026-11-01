'use strict';

/**
 * Omni-Skill-Proxy - 一键演示 / one-click demo
 *
 * 纯 Node 内置模块，零依赖。流程：
 *   1. 起一个 mock 上游（OpenAI + Anthropic 双格式 SSE）
 *   2. 启动真实网关 dist/index.js 指向 mock
 *   3. 绕过网关直连上游  -> 看到满屏废话
 *   4. 经过网关          -> 只剩纯粹代码
 *   5. 查看上游实际收到的 System Prompt（注入证明）
 *   6. 非流式 + Anthropic 格式同样验证
 *
 * Zero deps, built-in modules only. Runs entirely offline.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROXY_PORT = Number(process.env.OMNI_DEMO_PORT || 8899);
const PROXY_HOST = '127.0.0.1';

// ─── 模拟上游要返回的“废话 + 代码”流 / canned reply: filler + code ────────
const REPLY_CHUNKS = [
  '好的，当然可以！以下是你要的快速排序代码：\n\n',
  '```js\n',
  'function quickSort(arr) {\n',
  '  if (arr.length <= 1) return arr;\n',
  '  const pivot = arr[0];\n',
  '  const left = arr.slice(1).filter((x) => x < pivot);\n',
  '  const right = arr.slice(1).filter((x) => x >= pivot);\n',
  '  return quickSort(left).concat(pivot, quickSort(right));\n',
  '}\n',
  '```\n\n',
  '希望这段代码对你有帮助！如果还有问题，随时问我。',
];
const FULL_TEXT = REPLY_CHUNKS.join('');

const C = {
  dim: (s) => s,
  green: (s) => s,
  red: (s) => s,
  cyan: (s) => s,
};

function hr(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

/** 发起一个 HTTP 请求，返回 { statusCode, headers, res }。 */
function rawRequest(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: headers || {} },
      (res) => resolve({ statusCode: res.statusCode, headers: res.headers, res }),
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 累积 SSE 流中的文本增量（OpenAI 与 Anthropic 两种线路格式）。 */
function collectText(res, format) {
  return new Promise((resolve, reject) => {
    let text = '';
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const rawLine of event.split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (format === 'openai') {
            const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
            if (delta && typeof delta.content === 'string') text += delta.content;
          } else if (obj.type === 'content_block_delta') {
            const delta = obj.delta;
            if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') text += delta.text;
          }
        }
      }
    });
    res.on('end', () => resolve(text));
    res.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── mock 上游 / fake upstream ────────────────────────────────────────────
function startMock() {
  let lastBody = null;
  const server = http.createServer((req, res) => {
    if ((req.url || '').split('?')[0] === '/__last-request') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lastBody));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        lastBody = JSON.parse(raw);
      } catch {
        lastBody = raw;
      }
      const url = (req.url || '');
      const anthropic = url.includes('/messages');
      // 注意：OpenAI 非流式请求里 stream 字段是缺省（undefined），不是 false。
      const streaming = anthropic || (lastBody && lastBody.stream === true);

      // [mock] 回显上游线路格式（演示调试用）
      console.log(`[mock] ${req.method} ${url} -> ${anthropic ? 'anthropic' : 'openai'} ${streaming ? 'streaming' : 'non-streaming'}`);

      if (!anthropic && !streaming) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-demo',
          object: 'chat.completion',
          created: 1700000000,
          model: 'demo-model',
          choices: [{ index: 0, message: { role: 'assistant', content: FULL_TEXT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: 128, total_tokens: 170 },
        }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      // OpenAI 风格只有 data: 行；Anthropic 风格带 event: 行 —— 两种都测
      const writeSse = (data) => res.write(`data: ${data}\n\n`);
      const writeEvent = (eventType, data) => res.write(`event: ${eventType}\ndata: ${data}\n\n`);

      if (anthropic) {
        writeEvent('message_start', JSON.stringify({ type: 'message_start', message: { id: 'msg_demo', role: 'assistant', content: [] } }));
        writeEvent('content_block_start', JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        for (const chunk of REPLY_CHUNKS) {
          writeEvent('content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
          await sleep(6);
        }
        writeEvent('content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 }));
        writeEvent('message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
        writeEvent('message_stop', JSON.stringify({ type: 'message_stop' }));
      } else {
        for (const chunk of REPLY_CHUNKS) {
          writeSse(JSON.stringify({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', created: 1700000000, model: 'demo-model', choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
          await sleep(6);
        }
        writeSse(JSON.stringify({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', created: 1700000000, model: 'demo-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForProxy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await rawRequest(PROXY_PORT, 'GET', '/__health', {}, null);
      if (r.statusCode === 200) {
        r.res.resume();
        return true;
      }
      r.res.resume();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

// ─── main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Omni-Skill-Proxy · 一键演示 · one-click demo (offline)     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 0) 读取本目录 skills / list skills
  const skillsDir = path.join(ROOT, 'skills');
  const skillFiles = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((f) => f.endsWith('.skill.md'))
    : [];
  hr('STEP 0 · 已加载的 Skill 规则 / loaded skills');
  if (skillFiles.length === 0) {
    console.log('  (skills/ 目录为空，仅使用内置核心规则)');
  }
  for (const f of skillFiles) {
    const text = fs.readFileSync(path.join(skillsDir, f), 'utf8');
    const m = text.match(/^priority:\s*(\d+)/m);
    console.log(`  · ${f}  priority=${m ? m[1] : '0'}`);
  }

  // 1) 启动 mock 上游 / start fake upstream
  const mock = await startMock();
  const mockPort = mock.address().port;
  console.log(`\n[mock] fake upstream listening on 127.0.0.1:${mockPort}`);

  // 2) 启动真实网关 / spawn the real gateway
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      HOST: PROXY_HOST,
      PORT: String(PROXY_PORT),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${mockPort}`,
      SKILLS_DIR: skillsDir,
      INJECT: '1',
      STRIP: '1',
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`[gateway] exited with code ${code}`);
  });

  const teardown = () => {
    try { child.kill(); } catch {}
    try { mock.close(); } catch {}
  };
  process.on('SIGINT', () => { teardown(); process.exit(130); });

  if (!(await waitForProxy())) {
    console.error('\n[demo] 网关未能在 5s 内就绪 / gateway did not come up. Run `npm run build` first.');
    teardown();
    process.exit(1);
  }

  const openaiBody = JSON.stringify({
    model: 'demo-model',
    stream: true,
    messages: [{ role: 'user', content: '帮我写一个快速排序' }],
  });
  const anthropicBody = JSON.stringify({
    model: 'claude-demo',
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'user', content: '帮我写一个快速排序' }],
  });

  // 3) 直连上游（绕过网关）/ raw: straight to upstream
  hr('STEP 1 · 绕过网关直连上游（未过滤）/ RAW: bypassing the gateway');
  {
    const r = await rawRequest(mockPort, 'POST', '/v1/chat/completions', { 'content-type': 'application/json' }, openaiBody);
    const raw = await collectText(r.res, 'openai');
    console.log(raw);
    console.log(`\n  ↑ 共 ${raw.length} 字符：客套话 + 代码 + 客套话`);
  }

  // 4) 经过网关 / filtered: through the gateway
  hr('STEP 2 · 经过 Omni-Skill-Proxy（过滤后）/ FILTERED through the gateway');
  let filtered = '';
  {
    const r = await rawRequest(PROXY_PORT, 'POST', '/v1/chat/completions', { 'content-type': 'application/json' }, openaiBody);
    filtered = await collectText(r.res, 'openai');
    console.log(filtered);
  }

  // 5) 注入证明 / injection proof: what the upstream actually received
  hr('STEP 3 · 上游实际收到的 System Prompt / injection proof (from mock)');
  {
    const r = await rawRequest(mockPort, 'GET', '/__last-request', {}, null);
    const body = await new Promise((resolve) => {
      let d = '';
      r.res.on('data', (c) => (d += c));
      r.res.on('end', () => resolve(d));
    });
    const sent = JSON.parse(body);
    const sys = sent && sent.messages && sent.messages[0] && sent.messages[0].content;
    console.log(sys ? String(sys).slice(0, 600) : '(none)');
    console.log(`\n  ↑ 网关在转发前注入的 system 消息（截断 600 字符）`);
  }

  // 6) 非流式 / non-streaming
  hr('STEP 4 · 非流式请求（整体过滤）/ NON-STREAMING request');
  {
    const r = await rawRequest(
      PROXY_PORT,
      'POST',
      '/v1/chat/completions',
      { 'content-type': 'application/json' },
      JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: '帮我写一个快速排序' }] }),
    );
    const buf = await new Promise((resolve) => {
      let d = '';
      r.res.on('data', (c) => (d += c));
      r.res.on('end', () => resolve(d));
    });
    const obj = JSON.parse(buf);
    console.log(obj.choices[0].message.content);
  }

  // 7) Anthropic 格式 / anthropic wire format
  hr('STEP 5 · Anthropic /v1/messages 流式（同样过滤）/ ANTHROPIC format');
  {
    const r = await rawRequest(PROXY_PORT, 'POST', '/v1/messages', { 'content-type': 'application/json' }, anthropicBody);
    const text = await collectText(r.res, 'anthropic');
    console.log(text);
    const sysInfo = await rawRequest(mockPort, 'GET', '/__last-request', {}, null);
    const body = await new Promise((resolve) => {
      let d = '';
      sysInfo.res.on('data', (c) => (d += c));
      sysInfo.res.on('end', () => resolve(d));
    });
    const sent = JSON.parse(body);
    console.log(`\n  ↑ Anthropic system 字段已注入规则：${JSON.stringify(sent.system).slice(0, 120)}...`);
  }

  // 8) 汇总 / summary
  hr('SUMMARY · 前后对比 / before vs after');
  console.log(`  原始输出  raw      : ${FULL_TEXT.length} 字符`);
  console.log(`  过滤后    filtered : ${filtered.length} 字符`);
  console.log(`  剥离废话  stripped : ${FULL_TEXT.length - filtered.length} 字符`);
  console.log('\n  把所有客套话挡在网关之外，把最纯粹的代码留给开发者。');
  console.log('  Blocking every pleasantry at the gateway, keeping only pure code.\n');

  teardown();
  process.exit(0);
}

main().catch((err) => {
  console.error('[demo] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
