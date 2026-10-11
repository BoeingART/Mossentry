const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mossentry-desktop-'));
  const child = spawn(path.resolve(process.argv[2]), [`--remote-debugging-port=${port}`], {
    env: { ...process.env, MOSSENTRY_USER_DATA_DIR: data },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-5000); });
  let socket;
  let serviceOrigin;
  try {
    let page;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors || 'Desktop exited before opening');
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = pages.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
        if (page) break;
      } catch {}
      await delay(200);
    }
    assert.ok(page, `Desktop did not load its local service: ${errors}`);
    serviceOrigin = new URL(page.url).origin;
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let requestId = 0;
    async function evaluate(expression) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Renderer did not respond')), 5000);
        const onMessage = event => {
          const result = JSON.parse(event.data);
          if (result.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener('message', onMessage);
          if (result.error) reject(new Error(JSON.stringify(result.error)));
          else resolve(result.result.result.value);
        };
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
    }
    let rendered = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rendered = await evaluate(`document.title === 'Mossentry' && document.querySelector('#root')?.children.length > 0 && /Dashboard|仪表盘/.test(document.body.innerText)`);
      if (rendered) break;
      await delay(200);
    }
    assert.ok(rendered, `Dashboard did not render: ${errors}`);
    console.log('Packaged desktop opened and rendered the Dashboard successfully.');
  } finally {
    socket?.close();
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    await delay(1000);
    if (serviceOrigin) {
      let stopped = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try { await fetch(`${serviceOrigin}/health`); } catch { stopped = true; break; }
        await delay(200);
      }
      assert.ok(stopped, 'Backend remained running after the desktop exited');
    }
    await fs.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
