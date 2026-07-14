// AI Sound Monitor - ブラウザ側
//
// 役割:
//   ① サーバの /events (SSE) に繋ぐ
//   ② 接続時のスナップショットで「今の盤面」を描く
//   ③ イベントが来たら 状態ごとの音を鳴らし、盤面とログを更新する
//   ④ セッション終了(remove)が来たら盤面から取り除く
//   ⑤ 状態ごとに音のON/OFFを切り替えられる(通知疲れ対策・localStorageに保存)

// --- 状態の定義 ---
// priority: 小さいほど上に表示（要対応を先頭に持ってくる）
const STATES = {
  waiting: { label: '承認待ち', emoji: '⏳', color: '#f59e0b', priority: 0 },
  error:   { label: 'エラー',   emoji: '⛔', color: '#ef4444', priority: 1 },
  working: { label: '実行中',   emoji: '🔄', color: '#3b82f6', priority: 2 },
  done:    { label: '完了',     emoji: '✅', color: '#22c55e', priority: 3 },
};
const stateOf = (key) => STATES[key] || STATES.done;

// ===== 音の生成 (Web Audio API / 外部ファイル不要) =====
let audioCtx = null;
let enabled = false;

// 状態ごとの音ON/OFF設定(falseで消音。未設定はON)
const soundPrefs = JSON.parse(localStorage.getItem('soundPrefs') || '{}');

function enableAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  enabled = true;
}

// 1音を鳴らす (周波数・開始時刻・長さ・波形・音量)
function tone(freq, start, dur, type = 'sine', vol = 0.2) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// 状態ごとの音色パターン
const SOUND = {
  // 完了: 明るい上昇チャイム (ド→ミ→ソ)
  done: () => { const t = audioCtx.currentTime; tone(523.25, t, 0.15); tone(659.25, t + 0.12, 0.15); tone(783.99, t + 0.24, 0.28); },
  // 承認待ち: 注意を引く2連ビープ
  waiting: () => { const t = audioCtx.currentTime; tone(880, t, 0.12, 'square', 0.15); tone(880, t + 0.2, 0.12, 'square', 0.15); },
  // エラー: 低い下降ブザー
  error: () => { const t = audioCtx.currentTime; tone(220, t, 0.22, 'sawtooth', 0.18); tone(164.81, t + 0.2, 0.32, 'sawtooth', 0.18); },
  // 実行中: 控えめな単発ティック
  working: () => { const t = audioCtx.currentTime; tone(440, t, 0.08, 'sine', 0.1); },
};

// force=true は試聴ボタン用(OFF設定でも鳴らす)
function playState(state, force = false) {
  if (!enabled || !audioCtx) return;
  if (!force && soundPrefs[state] === false) return;
  (SOUND[state] || SOUND.done)();
}

// ===== 共通ユーティリティ =====
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 経過時間を「たった今 / 12秒前 / 3分前」の形にする
function ago(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 3) return 'たった今';
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  return `${Math.floor(min / 60)}時間前`;
}

// ===== ダッシュボード（各AIの現在状態） =====
const boardEl = document.getElementById('board');
const emptyBoard = document.getElementById('emptyBoard');
const countEl = document.getElementById('count');

let agents = new Map();   // AI名 -> { ai, state, message, time }

function renderBoard() {
  const list = [...agents.values()].sort((a, b) => {
    const d = stateOf(a.state).priority - stateOf(b.state).priority;   // 要対応を上に
    return d !== 0 ? d : new Date(b.time) - new Date(a.time);          // 同順位なら新しい方を上に
  });

  countEl.textContent = list.length;
  emptyBoard.style.display = list.length ? 'none' : '';

  boardEl.innerHTML = list.map((a) => {
    const s = stateOf(a.state);
    const attention = s.priority <= 1 ? ' agent--attention' : '';
    return `
      <li class="agent${attention}" style="border-left-color:${s.color}">
        <div class="agent-main">
          <span class="agent-name">${escapeHtml(a.ai)}</span>
          <span class="agent-state" style="color:${s.color}">${s.emoji} ${s.label}</span>
        </div>
        <div class="agent-sub">
          <span class="agent-msg">${escapeHtml(a.message || '')}</span>
          <span class="agent-time" data-time="${a.time}">${ago(a.time)}</span>
        </div>
      </li>`;
  }).join('');
}

// 経過時間を1秒ごとに更新する（再描画せず時刻表示だけ差し替える）
setInterval(() => {
  for (const el of boardEl.querySelectorAll('.agent-time')) {
    el.textContent = ago(el.dataset.time);
  }
}, 1000);

// ===== 受信ログ =====
const logEl = document.getElementById('log');
const emptyLog = document.getElementById('emptyLog');

function addLog(event) {
  emptyLog.style.display = 'none';
  const s = stateOf(event.state);
  const time = new Date(event.time || Date.now()).toLocaleTimeString('ja-JP');
  const li = document.createElement('li');
  li.className = 'log-item';
  li.style.borderLeftColor = s.color;
  li.innerHTML =
    `<span class="log-time">${time}</span>` +
    `<span class="log-ai">${escapeHtml(event.ai || 'AI')}</span>` +
    `<span class="log-state" style="color:${s.color}">${s.emoji} ${s.label}</span>` +
    `<span class="log-msg">${escapeHtml(event.message || '')}</span>`;
  logEl.prepend(li);
}

// セッション終了のログ(音なし・控えめ表示)
function addEndLog(msg) {
  emptyLog.style.display = 'none';
  const time = new Date(msg.time || Date.now()).toLocaleTimeString('ja-JP');
  const li = document.createElement('li');
  li.className = 'log-item log-item--end';
  li.innerHTML =
    `<span class="log-time">${time}</span>` +
    `<span class="log-ai">${escapeHtml(msg.ai)}</span>` +
    `<span class="log-msg">🚪 セッション終了（盤面から削除）</span>`;
  logEl.prepend(li);
}

// ===== 凡例 (試聴 + 音ON/OFFつき) =====
const legendEl = document.getElementById('legend');
for (const [key, s] of Object.entries(STATES)) {
  const li = document.createElement('li');
  li.className = 'legend-item';
  li.style.borderLeftColor = s.color;

  const label = document.createElement('span');
  label.className = 'legend-label';
  label.textContent = `${s.emoji} ${s.label}`;

  const controls = document.createElement('div');
  controls.className = 'legend-controls';

  // 音のON/OFF(状態ごと・localStorageに保存)
  const toggle = document.createElement('label');
  toggle.className = 'sound-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = soundPrefs[key] !== false;
  box.addEventListener('change', () => {
    soundPrefs[key] = box.checked;
    localStorage.setItem('soundPrefs', JSON.stringify(soundPrefs));
  });
  toggle.append(box, document.createTextNode('音'));

  const btn = document.createElement('button');
  btn.className = 'try-btn';
  btn.textContent = '試聴';
  btn.addEventListener('click', () => { if (!enabled) enableAudio(); playState(key, true); });

  controls.append(toggle, btn);
  li.append(label, controls);
  legendEl.appendChild(li);
}

// ===== ボタン =====
document.getElementById('enableBtn').addEventListener('click', (e) => {
  enableAudio();
  e.target.textContent = '🔊 音: 有効';
  e.target.classList.add('on');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  fetch('/clear').catch(() => {});   // サーバ側でクリア → スナップショットが返ってくる
});

// ===== サーバへ SSE 接続 =====
const connEl = document.getElementById('conn');

function connect() {
  const es = new EventSource('/events');

  es.onopen = () => { connEl.textContent = '● 接続中'; connEl.className = 'conn conn--on'; };
  es.onerror = () => { connEl.textContent = '● 再接続中…'; connEl.className = 'conn conn--off'; };

  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'snapshot') {
      // 接続直後（またはクリア後）: 今の盤面を丸ごと反映。音は鳴らさない
      agents = new Map(msg.agents.map((a) => [a.ai, a]));
      renderBoard();
      return;
    }

    if (msg.type === 'remove') {
      // セッション終了: 盤面から取り除く。音は鳴らさない
      agents.delete(msg.ai);
      renderBoard();
      addEndLog(msg);
      return;
    }

    if (msg.type === 'event') {
      agents.set(msg.ai, msg);
      renderBoard();
      addLog(msg);
      playState(msg.state);
    }
  };
}

connect();
