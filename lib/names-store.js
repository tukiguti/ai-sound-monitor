// names-store.js — 名前マップ(ディレクトリ名 -> 表示名/読み名)の一元管理
//
// server.js と lib/discord-bot.js の両方が「このファイルだけ」を参照する。
// (server.js ⇄ lib/discord-bot.js が互いを import し合う循環を作らないための共通置き場。
//  lib/voice-settings.js と同じ考え方)
//
// config/names.json は「コミット対象だが実行時に育つ」ファイルという設計(docs/設計.md §3)。
// 未登録プロジェクトからイベントが届くとサーバが自動追記し、/name set からの変更も同じ config/names.json に書く。
// (lib/voice-settings.js が変更値を gitignore 済みの .data/voice-override.json に書くのとは異なる点。
//  config/names.json はもともとサーバが自動追記して育てるファイルなので、コマンドからの変更も同じ config/names.json に集約するのが一貫している。§3 参照)
// config/names.json への書き込みはこのファイルに一本化する(server.js から直接書かない)。

import { readFileSync, writeFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));   // lib/ を指す
const NAMES_FILE = path.join(__dirname, '..', 'config', 'names.json');

// --- 起動時に config/names.json を読み込む(無ければ空マップ=素の名前を使う) ---
// プロセス内に保持し、registerName / setName の変更を次のイベントから即反映できるようにする。
let names = {};
try { names = JSON.parse(readFileSync(NAMES_FILE, 'utf8')); } catch { /* マップが無ければ素の名前を使う */ }

// config/names.json へ保存する(投げっぱなし・失敗してもサーバは止めない)。
function save() {
  writeFile(NAMES_FILE, JSON.stringify(names, null, 2) + '\n', () => {});
}

// base(セッションID部分を落としたディレクトリ名)の表示名を返す。マップに無ければ base のまま。
// (呼び出し側で baseOf(ai) してから渡す)
export function getLabel(base) {
  return names[base] || base;
}

// 未登録のプロジェクトを config/names.json に自動追記する(読み名は人間が後で書き換える)。
// 登録済みなら何もしない(呼び出し側は毎回呼んでよい)。
export function registerName(base) {
  if (base in names) return;
  names[base] = base;
  save();
  console.log(`[names] 新しいプロジェクト「${base}」を config/names.json に登録しました(読み名は /name set か編集で変更できます)`);
}

// base の表示名を label に設定し、config/names.json へ保存する(/name set 用)。
// 空文字列や null が来たら何もしない(呼び出し側でもガードする)。
export function setName(base, label) {
  if (!base || !label) return;
  names[base] = label;
  save();
  console.log(`[names] 「${base}」の表示名を「${label}」に変更しました`);
}

// 現在の names マップのコピーを返す(/name list 用)。
export function listNames() {
  return { ...names };
}
