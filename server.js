// AI Sound Monitor - ローカルサーバ (依存ゼロ / Node標準httpのみ)
//
// 役割は3つ:
//   ① Webページ(public/)を配信する
//   ② /notify  … ターミナル(curl や Claude Code hook)からイベントを受け取る
//   ③ /events  … ブラウザへ Server-Sent Events(SSE) でイベントを中継する
//
// 起動: node server.js   (または npm start)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = process.env.PORT || 4123;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// 接続中のブラウザ(SSEクライアント)を保持する
const clients = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// 受け取ったイベントを、繋がっている全ブラウザへ流す
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
  console.log(`[notify] ${event.ai} → ${event.state} ${event.message ? '(' + event.message + ')' : ''}  受信中ブラウザ:${clients.size}`);
}

// クエリ or JSONボディからイベントを組み立てる
function buildEvent(params, body) {
  let data = {};
  if (body) {
    try { data = JSON.parse(body); } catch { /* JSONでなければ無視してクエリを使う */ }
  }
  return {
    ai: data.ai || params.get('ai') || 'AI',
    state: data.state || params.get('state') || 'done',
    message: data.message || params.get('message') || '',
    time: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    // 不正なURL(生の日本語をそのまま入れた等)で固まらないようにする
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: URLに使えない文字があります。日本語は --data-urlencode かパーセントエンコードで送ってください。');
    return;
  }

  // --- ③ SSE: ブラウザがここに繋いでイベントを待つ ---
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');       // 切れたら3秒後に自動再接続
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- ② イベント受信: curl / hook がここを叩く ---
  if (url.pathname === '/notify') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const event = buildEvent(url.searchParams, body);
        broadcast(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event }));
      });
      return;
    }
    // GETでも鳴らせる(hookやブラウザから手軽に叩けるように)
    const event = buildEvent(url.searchParams, '');
    broadcast(event);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, event }));
    return;
  }

  // --- ① 静的ファイル配信 (public/ 配下のみ) ---
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {          // ディレクトリトラバーサル防止
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log(' AI Sound Monitor 起動');
  console.log(`  画面   : http://localhost:${PORT}`);
  console.log(`  鳴らす : curl "http://localhost:${PORT}/notify?state=done&ai=test"`);
  console.log('==============================================');
});
