// AI Sound Monitor - ローカルサーバ (依存ゼロ / Node標準httpのみ)
//
// 役割:
//   ① Webページ(public/)を配信する
//   ② /notify  … ターミナル(curl や Claude Code hook)からイベントを受け取る
//   ③ /events  … ブラウザへ Server-Sent Events(SSE) でイベントを中継する
//   ④ 各AIの「現在状態」を保持し、ブラウザ接続時にスナップショットを送る
//   ⑤ 状態を .state.json に保存し、サーバ再起動後も盤面を復元する
//
// 状態の特別扱い:
//   state=ended … そのAI(セッション)を盤面から取り除く (SessionEnd hook用)
//
// 起動: node server.js   (または npm start)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = process.env.PORT || 4123;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.state.json');

const clients = new Set();        // 接続中のブラウザ(SSEクライアント)
const agents = new Map();         // AI名 -> 最新状態 { ai, state, message, time }

// 前回終了時の盤面を復元する
try {
  for (const a of JSON.parse(readFileSync(STATE_FILE, 'utf8'))) agents.set(a.ai, a);
  if (agents.size) console.log(`[state] 前回の盤面 ${agents.size} 件を復元`);
} catch { /* 初回起動などファイルが無ければ何もしない */ }

function saveState() {
  writeFile(STATE_FILE, JSON.stringify([...agents.values()], null, 2), () => {});
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 全ブラウザへ流す
function broadcast(payload) {
  for (const res of clients) send(res, payload);
}

// クエリ or JSONボディからイベントを組み立てる
function buildEvent(params, body) {
  let data = {};
  if (body) {
    try { data = JSON.parse(body); } catch { /* JSONでなければクエリを使う */ }
  }
  return {
    ai: data.ai || params.get('ai') || 'AI',
    state: data.state || params.get('state') || 'done',
    message: data.message || params.get('message') || '',
    time: new Date().toISOString(),
  };
}

function handleEvent(event) {
  // セッション終了: 盤面から取り除く(音は鳴らさない)
  if (event.state === 'ended') {
    if (agents.delete(event.ai)) saveState();
    broadcast({ type: 'remove', ai: event.ai, time: event.time });
    console.log(`[notify] ${event.ai} → セッション終了(削除)  監視中:${agents.size}  ブラウザ:${clients.size}`);
    return;
  }
  agents.set(event.ai, event);                 // 現在状態を更新(同名は上書き)
  saveState();
  broadcast({ type: 'event', ...event });      // ブラウザへ通知(音+盤面更新)
  console.log(`[notify] ${event.ai} → ${event.state} ${event.message ? '(' + event.message + ')' : ''}  監視中:${agents.size}  ブラウザ:${clients.size}`);
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

  // --- ③④ SSE: 接続直後にスナップショット、以降はイベントを流す ---
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');                                   // 切れたら3秒後に自動再接続
    send(res, { type: 'snapshot', agents: [...agents.values()] });  // 今の盤面を渡す
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- ② イベント受信: curl / Claude Code hook がここを叩く ---
  if (url.pathname === '/notify') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const event = buildEvent(url.searchParams, body);
        handleEvent(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event }));
      });
      return;
    }
    // GETでも鳴らせる(hookやブラウザから手軽に叩けるように)
    const event = buildEvent(url.searchParams, '');
    handleEvent(event);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, event }));
    return;
  }

  // --- 一覧をリセット(古くなったAIを消す) ---
  if (url.pathname === '/clear') {
    agents.clear();
    saveState();
    broadcast({ type: 'snapshot', agents: [] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: true }));
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
