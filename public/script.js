// AI Sound Monitor - ブラウザ側
//
// 役割:
//   ① サーバの /events (SSE) に繋ぐ
//   ② イベントが来たら、状態ごとの音を鳴らす
//   ③ 受信ログを画面に出す

// --- 状態の定義 (状態ごとに ラベル・絵文字・色) ---
const STATES = {
  done:    { label: '完了',     emoji: '✅', color: '#22c55e' },
  waiting: { label: '承認待ち', emoji: '⏳', color: '#f59e0b' },
  error:   { label: 'エラー',   emoji: '⛔', color: '#ef4444' },
  working: { label: '実行中',   emoji: '🔄', color: '#3b82f6' },
};

// ===== 音の生成 (Web Audio API / 外部ファイル不要) =====
let audioCtx = null;
let enabled = false;

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

function playState(state) {
  if (!enabled || !audioCtx) return;
  (SOUND[state] || SOUND.done)();
}

// ===== 凡例 (試聴つき) =====
const legendEl = document.getElementById('legend');
for (const [key, s] of Object.entries(STATES)) {
  const li = document.createElement('li');
  li.className = 'legend-item';
  li.style.borderLeftColor = s.color;
  const label = document.createElement('span');
  label.className = 'legend-label';
  label.textContent = `${s.emoji} ${s.label}`;
  const btn = document.createElement('button');
  btn.className = 'try-btn';
  btn.textContent = '試聴';
  btn.addEventListener('click', () => { if (!enabled) enableAudio(); playState(key); });
  li.append(label, btn);
  legendEl.appendChild(li);
}

// ===== 音の有効化ボタン =====
const enableBtn = document.getElementById('enableBtn');
enableBtn.addEventListener('click', () => {
  enableAudio();
  enableBtn.textContent = '🔊 音: 有効';
  enableBtn.classList.add('on');
});

// ===== 受信ログ =====
const logEl = document.getElementById('log');
const emptyLog = document.getElementById('emptyLog');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addLog(event) {
  emptyLog.style.display = 'none';
  const s = STATES[event.state] || STATES.done;
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

// ===== サーバへ SSE 接続 =====
const connEl = document.getElementById('conn');

function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { connEl.textContent = '● 接続中'; connEl.className = 'conn conn--on'; };
  es.onerror = () => { connEl.textContent = '● 再接続中…'; connEl.className = 'conn conn--off'; };
  es.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    addLog(event);
    playState(event.state);
  };
}

connect();
