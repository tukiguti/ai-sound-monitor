// discord-voice.js — DiscordボイスチャンネルでのVOICEVOX読み上げ再生
//
// このファイルの役割は「discord.js / @discordjs/voice への依存をここだけに閉じ込める」こと。
// server.js は依存ゼロ(Node標準のみ)で動く方針を守っており、この機能を使わないユーザーは
// npm install すら不要のまま今まで通り動く。そのための工夫が2つある:
//   1) Bot Token とボイスチャンネルIDの両方が設定されていなければ、discord.js を import すらしない
//   2) import に失敗(=npm install していない)しても握りつぶし、サーバ本体は止めない
//
// Bot Token は Webhook URL よりさらに機微な資格情報(乗っ取ればBotとして発言・接続などができる)なので、
// 中身をログに出すことは一切しない(docs/設計.md §7 / §10 参照)。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCORD_FILE = path.join(__dirname, 'discord.json');

// 接続状態を1箇所に集約する(server.js からは直接触らせない)
const state = {
  client: null,       // Discord Client
  connection: null,   // VoiceConnection(未接続なら null)
  player: null,       // AudioPlayer(再生を直列化する)
  voice: null,        // @discordjs/voice モジュール(createAudioResource 等を再生時に使う)
};

// 設定を1項目読む: 環境変数が最優先、無ければ discord.json(既存の webhookUrl と同じ作法)。
// discord.json.example のプレースホルダ(全角「（」で始まる説明文)はコピーしただけの未設定として扱う。
function readSetting(envValue, fileKey) {
  if (envValue) return envValue;
  try {
    const v = JSON.parse(readFileSync(DISCORD_FILE, 'utf8'))[fileKey];
    if (typeof v === 'string' && v && !v.startsWith('（')) return v;
  } catch { /* discord.json が無い/壊れていれば未設定として扱う */ }
  return '';
}

function loadConfig() {
  return {
    botToken: readSetting(process.env.DISCORD_BOT_TOKEN, 'botToken'),
    voiceChannelId: readSetting(process.env.DISCORD_VOICE_CHANNEL_ID, 'voiceChannelId'),
  };
}

// server.js が起動ログに「設定あり/未設定」を出すために使う。
// 実際に接続できたかどうかは initVoiceBot() が別途 [voice-bot] ログに出す。
export function isVoiceConfigured() {
  const { botToken, voiceChannelId } = loadConfig();
  return Boolean(botToken && voiceChannelId);
}

// サーバ起動時に1回だけ呼ぶ。設定が無ければ何もしない(discord.js を import すらしない)。
export async function initVoiceBot() {
  const { botToken, voiceChannelId } = loadConfig();
  if (!botToken || !voiceChannelId) return;   // 未設定: 依存ゼロのまま今まで通り

  // 設定があるときだけ動的import。npm install していなければここで失敗する。
  let discordjs, voice;
  try {
    discordjs = await import('discord.js');
    voice = await import('@discordjs/voice');
  } catch {
    console.log('[voice-bot] Discordボイスチャンネル機能を使うには npm install が必要です(この機能を使わなければ不要)');
    return;   // 機能だけ無効化・本体は継続
  }

  try {
    await connect(discordjs, voice, botToken, voiceChannelId);
    console.log('[voice-bot] ボイスチャンネルに接続しました');
  } catch (e) {
    // トークン誤り・権限不足・チャンネルID誤り等。秘密は出さずメッセージだけログする。
    console.log('[voice-bot] ボイスチャンネルへの接続に失敗しました(機能は無効・本体は継続): ' + e.message);
    teardown();
  }
}

// login → ready → チャンネル取得 → 参加 → プレイヤー購読 までを行う。
async function connect(discordjs, voice, botToken, voiceChannelId) {
  const { Client, GatewayIntentBits, Events } = discordjs;
  const {
    joinVoiceChannel, createAudioPlayer, entersState,
    VoiceConnectionStatus, NoSubscriberBehavior,
  } = voice;

  // 必要最小限のIntentだけ要求する(ボイス接続に要る Guilds / GuildVoiceStates のみ。
  // メッセージ内容の読み取り等の特権Intentは要求しない)。
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  state.client = client;
  state.voice = voice;

  // ready のリスナを張ってから login する(先に張らないとイベントを取りこぼす可能性がある)。
  const ready = waitReady(client, Events);
  await client.login(botToken);
  await ready;

  const channel = await client.channels.fetch(voiceChannelId);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error('指定IDのチャンネルが見つからない、またはボイスチャンネルではありません');
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,   // 自分の声は出す(相手の声は聞かないが読み上げは流す)
  });
  state.connection = connection;
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);   // 接続確立を待つ

  // AudioPlayerは1つだけ作り、購読も1回だけ。再生はこのプレイヤーが直列化する。
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(player);
  state.player = player;

  // 切断時の基本的な再接続(@discordjs/voice 公式ドキュメント推奨パターン)。
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // 5秒以内に再シグナリング/再接続へ移れれば、一時的な切断として自然回復を待つ。
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      // 戻らなければ本当に切れたとみなして破棄する(再参加はサーバ再起動で行う)。
      try { connection.destroy(); } catch { /* 破棄済みなら無視 */ }
      if (state.connection === connection) state.connection = null;
      console.log('[voice-bot] ボイスチャンネルから切断されました(再参加はサーバ再起動で)');
    }
  });
}

// ClientReady を待つ(login後に喋れる状態になるのを待つ)。一定時間で諦める。
function waitReady(client, Events) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ログイン後の準備がタイムアウトしました')), 15_000);
    client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
    client.once(Events.Error, (e) => { clearTimeout(timer); reject(e); });
  });
}

// 生成済みWAVをボイスチャンネルで再生し、再生完了まで待つ。
// 未接続なら何もしない(no-op)。呼び出し側(server.js の speakOnce)は読み上げキューで直列化して
// いるので同時呼び出しは実際には起きないが、AudioPlayer は play() のたびに現在の再生を差し替えるため、
// 万一多重に呼ばれても壊れはしない。
export function playInVoice(filePath) {
  const { connection, player, voice } = state;
  if (!connection || !player || !voice) return Promise.resolve();   // 未接続: 何もしない

  const { createAudioResource, AudioPlayerStatus } = voice;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onIdle = () => finish();                       // 再生完了(Idleへ復帰)
    const onError = (e) => { console.log('[voice-bot] ボイス再生でエラー: ' + e.message); finish(); };

    try {
      // play() の前にリスナを張り、短い音声でも完了イベント(Idle)を取りこぼさないようにする。
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
      timer = setTimeout(finish, 60_000);                // 万一Idleが来なくても60秒で諦める(呼び出し側を待たせ続けない)
      player.play(createAudioResource(filePath));
    } catch (e) {
      console.log('[voice-bot] ボイス再生の開始に失敗: ' + e.message);
      finish();
    }
  });
}

// 接続に失敗した/破棄するときの後始末。以降 playInVoice() は no-op になる。
function teardown() {
  try { state.connection?.destroy(); } catch { /* 破棄済みなら無視 */ }
  try { Promise.resolve(state.client?.destroy?.()).catch(() => {}); } catch { /* 無視 */ }
  state.client = null;
  state.connection = null;
  state.player = null;
  state.voice = null;
}
