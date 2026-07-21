// voice-settings.js — 読み上げ設定(話者・音量・速さ)の一元管理
//
// server.js と lib/discord-bot.js の両方が「このファイルだけ」を参照する。
// (server.js ⇄ lib/discord-bot.js が互いを import し合う循環を作らないための共通置き場)
//
// 設定の優先順位は既存の挙動を変えず、次の通り:
//   環境変数 VOICEVOX_SPEAKER(話者のみ・最優先) > .data/voice-override.json > config/config.json の既定値
//
// config/config.json は「コミット対象の既定値」なので、この機能からは絶対に書き込まない。
// /voice set で変更した値は、gitignore 済みの .data/voice-override.json にだけ書き出す
// (コミット対象ファイルへ書くと git 差分が汚れるため。詳細は docs/設計.md §3)。

import { readFileSync, writeFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));   // lib/ を指す
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'config.json');
const OVERRIDE_FILE = path.join(__dirname, '..', '.data', 'voice-override.json');   // /voice set の保存先(gitignore済み)

// --- 基本の既定値: config/config.json の voice を読む(既存の server.js と同じ挙動) ---
const defaults = { speaker: 14, volume: 1.0, speed: 1.0 };
try {
  const user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(defaults, user.voice);
} catch { /* config/config.jsonが無い/壊れていれば既定値で動く */ }

// --- 上書き設定: .data/voice-override.json を読む(あれば既定値へ被せる) ---
// プロセス内に保持し、/voice set の変更を次の読み上げから即反映できるようにする。
let override = {};
try {
  const saved = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') override = saved;
} catch { /* 無ければ上書きなし(既定値のまま動く) */ }

// 上書き設定を .data/voice-override.json へ保存する(投げっぱなし・失敗してもサーバは止めない)。
function saveOverride() {
  writeFile(OVERRIDE_FILE, JSON.stringify(override, null, 2) + '\n', () => {});
}

// 現在有効な { speaker, volume, speed } を返す。
// 優先順位: 環境変数 VOICEVOX_SPEAKER(話者のみ・最優先) > .data/voice-override.json > config/config.json の既定値。
// (?? を使い、volume=0 や speaker=0 のような有効な 0 を弾かないようにする)
export function getVoiceConfig() {
  const merged = {
    speaker: override.speaker ?? defaults.speaker,
    volume: override.volume ?? defaults.volume,
    speed: override.speed ?? defaults.speed,
  };
  // 環境変数 VOICEVOX_SPEAKER は話者のみ・最優先(既存ルールを変えない)。
  if (process.env.VOICEVOX_SPEAKER) merged.speaker = process.env.VOICEVOX_SPEAKER;
  return merged;
}

// { speaker?, volume?, speed? } の一部を受け取り、現在の上書き設定へマージして保存する。
// 保存後の完全な設定(getVoiceConfig と同じ優先順位を適用した結果)を返す(コマンドの返信に使う)。
export function setVoiceConfig(partial) {
  for (const key of ['speaker', 'volume', 'speed']) {
    // undefined/null(未指定)は無視し、指定された項目だけ上書きする。
    if (partial[key] !== undefined && partial[key] !== null) override[key] = partial[key];
  }
  saveOverride();
  return getVoiceConfig();
}
