// AI Sound Monitor - ローカルサーバ (依存ゼロ / Node標準httpのみ)
//
// 役割:
//   ① Webページ(public/)を配信する
//   ② /notify  … ターミナル(curl や Claude Code hook)からイベントを受け取る
//   ③ /events  … ブラウザへ Server-Sent Events(SSE) でイベントを中継する
//   ④ 各AIの「現在状態」を保持し、ブラウザ接続時にスナップショットを送る
//   ⑤ 状態を .state.json に保存し、サーバ再起動後も盤面を復元する
//   ⑥ VOICEVOX で「〇〇が一段落しました」と読み上げる (ENGINE未起動なら自動スキップ)
//   ⑦ names.json でAI名を表示名に変換し、同名が複数あるときは番号(1,2,3…)で区別する
//   ⑧ Discord Bot へ一段落・承認待ち・エラーを投稿する (通知先は /notify here で指定・未指定なら何もしない)
//   ⑨ config.json で話者・音量・速さ・チャイム音量を設定できる(話者・音量・速さは Discord の /voice set でも再起動なしに変更可)
//
// 状態の特別扱い:
//   state=ended … そのAI(セッション)を盤面から取り除く (SessionEnd hook用)
//   quiet=1     … 盤面更新・SSE配信(ブラウザのチャイム)は従来どおり行い、読み上げとDiscord投稿だけ抑制する
//                 (短いターンの「一段落」を鳴らしすぎない用。hook側が経過時間で付ける)
//
// 起動: node server.js   (または npm start)

import http from 'node:http';
import { readFile, writeFile as writeFileAsync, unlink } from 'node:fs/promises';
import { readFileSync, writeFile } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initBot, playInVoice, isBotConfigured, sendText } from './discord-bot.js';
import { getVoiceConfig } from './voice-settings.js';
import { getLabel, registerName } from './names-store.js';

const PORT = process.env.PORT || 4123;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.state.json');

const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://localhost:50021';

// ===== 音の設定 =====
// 読み上げ(話者・音量・速さ)は voice-settings.js が一元管理する(config.json の voice + .voice-override.json)。
//   getVoiceConfig() を読み上げのたびに呼ぶことで、/voice set の変更が再起動なしに次の読み上げから反映される。
//   話者IDの全一覧: curl -s http://localhost:50021/speakers | jq -r '.[] | .name as $n | .styles[] | "\(.id)=\($n)（\(.name)）"'
// ここで config.json から読むのはブラウザのチャイム音量(chime.volume)だけ(1.0=標準、0で消音)。
//   反映にはサーバ再起動＋ブラウザ再読み込みが必要(今回のスコープ外)。
const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = {
  chime: { volume: 1.0 },
};
try {
  const user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(config.chime, user.chime);
} catch { /* config.jsonが無い/壊れていれば既定値で動く */ }

const SPEAK_STATES = { done: 'が一段落しました', waiting: 'が承認待ちです' };  // 読み上げる状態と語尾

// Discordへ投げる状態と文面(working/ended は通知しない)
const STATE_TEXT = { done: 'が一段落しました', waiting: 'が承認待ちです', error: 'がエラーです' };
const STATE_EMOJI = { done: '✅', waiting: '⏳', error: '⛔' };

const clients = new Set();        // 接続中のブラウザ(SSEクライアント)
const agents = new Map();         // AI名 -> 最新状態 { ai, state, message, time, label, num }

// 前回終了時の盤面を復元する
try {
  for (const a of JSON.parse(readFileSync(STATE_FILE, 'utf8'))) agents.set(a.ai, a);
  if (agents.size) console.log(`[state] 前回の盤面 ${agents.size} 件を復元`);
} catch { /* 初回起動などファイルが無ければ何もしない */ }

// 起動時に古いエントリを掃除する(SessionEndが飛ばない異常終了で残る「実行中」等の残骸対策)
// 24時間より前の event.time を持つエントリは削除する(起動時のみ・定期実行はしない)
{
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  for (const [ai, a] of agents) {
    const t = Date.parse(a.time);
    if (Number.isFinite(t) && now - t > STALE_MS) { agents.delete(ai); removed++; }
  }
  if (removed) {
    console.log(`[state] 24時間以上前の古いエントリを${removed}件削除`);
    saveState();
  }
}

function saveState() {
  writeFile(STATE_FILE, JSON.stringify([...agents.values()], null, 2), () => {});
}

// --- ⑦ 名前マップ: ディレクトリ名 -> 表示名 (表示と読み上げの両方で使う) ---
// マップの読み書き(names.json)は names-store.js に集約している(server.js ⇄ discord-bot.js の
// 循環 import を避ける共通置き場。voice-settings.js と同じ考え方)。
// server.js は baseOf() でセッションID部分を落とし、getLabel() / registerName() を呼ぶだけ。

const baseOf = (ai) => ai.split('#')[0];   // セッションID部分を落とす

// 同じベース名の稼働中セッションに 1,2,3… を振る(空き番号の最小を使う)
function assignNum(ai) {
  const base = baseOf(ai);
  const used = new Set([...agents.values()].filter((a) => baseOf(a.ai) === base).map((a) => a.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// --- ⑧ Discord通知は discord-bot.js が担当(テキストは sendText / ボイスは playInVoice)。
//        通知先は Bot のスラッシュコマンド /notify here で指定する(未指定なら投稿しない)。 ---

// --- ⑥ VOICEVOX 読み上げ (サーバ側で再生するのでブラウザを開いていなくても喋る) ---

const speakQueue = [];   // 読み上げ待ちのテキスト
let speaking = false;    // ワーカー稼働中か(2つ同時に喋って重ならないようにする)
let speakSeq = 0;        // 一時ファイル名を一意にする連番

// 読み上げを依頼する(投げっぱなし: /notify の応答は待たせない)
function speak(text) {
  speakQueue.push(text);
  if (!speaking) runSpeakQueue();
}

// キューを直列に処理する。どこで失敗してもサーバ本体は止めない
async function runSpeakQueue() {
  speaking = true;
  while (speakQueue.length) {
    const text = speakQueue.shift();
    try {
      await speakOnce(text);
    } catch (e) {
      console.log('[voice] 読み上げ失敗(ENGINEは起動していますか?): ' + e.message);
    }
  }
  speaking = false;
}

// ①audio_query → ②synthesis → ③一時WAVに書く → ④afplayで再生 → ⑤一時ファイル削除
async function speakOnce(text) {
  const voice = getVoiceConfig();                             // 読み上げのたびに現在の設定を取り込む(/voice set が即反映される)
  const speaker = encodeURIComponent(voice.speaker);
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`,
    { method: 'POST', signal: AbortSignal.timeout(10000) },   // ENGINEが無反応でもキューを詰まらせない
  );
  if (!queryRes.ok) throw new Error(`audio_query が ${queryRes.status}`);

  const query = await queryRes.json();
  query.volumeScale = voice.volume;                           // 音量・速さは現在の設定から(voice-settings.js)
  query.speedScale = voice.speed;
  const synthRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30000),
  });
  if (!synthRes.ok) throw new Error(`synthesis が ${synthRes.status}`);

  const file = path.join(tmpdir(), `ai-sound-monitor-${process.pid}-${speakSeq++}.wav`);
  await writeFileAsync(file, Buffer.from(await synthRes.arrayBuffer()));
  try {
    // 同じWAVをローカル再生(afplay)とボイスチャンネル再生の両方で使い回す(VOICEVOXへ二重に合成を投げない)。
    // allSettled にしているので、片方が失敗してももう片方は最後まで再生され、全体が落ちることもない。
    await Promise.allSettled([playFile(file), playInVoice(file)]);
  } finally {
    await unlink(file).catch(() => {});                       // 両方の再生が終わってから片付ける
  }
}

// afplay(macOS標準)で再生し、鳴り終わるまで待つ
function playFile(file) {
  return new Promise((resolve, reject) => {
    const player = spawn('afplay', [file]);
    player.on('error', reject);                               // afplayが無い等
    player.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`afplay 終了コード ${code}`))));
  });
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
    quiet: data.quiet || params.get('quiet') || '',   // truthy なら読み上げとDiscord投稿だけ抑制(盤面・チャイムは通常どおり)
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
  const prev = agents.get(event.ai);
  event.num = prev ? prev.num : assignNum(event.ai);   // セッション存続中は番号を変えない
  const base = baseOf(event.ai);
  registerName(base);              // 未登録なら names.json に自動追記(登録済みなら何もしない)
  event.label = getLabel(base);

  agents.set(event.ai, event);                 // 現在状態を更新(同名は上書き)
  saveState();
  broadcast({ type: 'event', ...event });      // ブラウザへ通知(音+盤面更新)

  // 同じ名前が複数稼働しているときだけ番号で区別する(1つだけなら番号なし)
  const live = [...agents.values()].filter((a) => baseOf(a.ai) === baseOf(event.ai)).length;
  const who = live > 1 ? `${event.label}の${event.num}番` : event.label;

  // quiet(短いターン等)のときは、盤面更新・broadcast(チャイム)は上で済ませたうえで、
  // 読み上げ(speak)とDiscord投稿(sendText)だけを抑制する。「意味のある区切り」だけを声/通知に絞るため。
  const quiet = !!event.quiet;

  // 完了・承認待ちだけ読み上げる(working/error はチャイム音のみ)
  const suffix = SPEAK_STATES[event.state];
  if (suffix && !quiet) speak(who + suffix);

  // Discordへは完了・承認待ち・エラーを投稿する(working は対象外)
  if (STATE_TEXT[event.state] && !quiet) {
    sendText(`${STATE_EMOJI[event.state]} **${who}**${STATE_TEXT[event.state]}${event.message ? ' — ' + event.message : ''}`);
  }

  console.log(`[notify] ${event.ai} → ${event.state}${quiet ? ' (quiet)' : ''} ${event.message ? '(' + event.message + ')' : ''}  監視中:${agents.size}  ブラウザ:${clients.size}`);
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
    // 長時間アイドルでも経路で切られないよう、定期的にコメント行を送る(keep-alive)
    const keepAlive = setInterval(() => res.write(':\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);   // 接続が閉じたらタイマーを止める(メモリリーク防止)
      clients.delete(res);
    });
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

  // --- 音の設定をブラウザへ渡す(チャイム音量) ---
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chime: config.chime }));
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

server.listen(PORT, '127.0.0.1', () => {   // localhost(ループバック)のみで待受(認証なし前提・同一LANからは叩けない)
  console.log('==============================================');
  console.log(' AI Sound Monitor 起動');
  console.log(`  画面   : http://localhost:${PORT}`);
  console.log(`  鳴らす : curl "http://localhost:${PORT}/notify?state=done&ai=test"`);
  console.log(isBotConfigured()
    ? '  Discord Bot : 設定あり(ログインを試みます… 結果は [discord-bot] ログに出ます。通知先は /notify here、読み上げは /join で指定)'
    : '  Discord Bot : 未設定(discord.json か DISCORD_BOT_TOKEN で有効化・要 npm install)');
  console.log('==============================================');
  initBot();   // Bot Token があればログイン(未設定/未installなら自動スキップ)
});
