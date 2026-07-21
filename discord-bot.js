// discord-bot.js — Discord Bot(テキスト通知＋ボイスチャンネル読み上げ＋スラッシュコマンド)
//
// このファイルの役割は「discord.js / @discordjs/voice への依存をここだけに閉じ込める」こと。
// server.js は依存ゼロ(Node標準のみ)で動く方針を守っており、この機能を使わないユーザーは
// npm install すら不要のまま今まで通り動く。そのための工夫が2つある:
//   1) Bot Token が設定されていなければ、discord.js を import すらしない
//   2) import に失敗(=npm install していない)しても握りつぶし、サーバ本体は止めない
//
// Bot Token はこのツールで唯一の資格情報(乗っ取ればBotとして発言・接続などができる)なので、
// 中身をログに出すことは一切しない(docs/設計.md §7 / §9 参照)。
//
// 通知先の指定はスラッシュコマンドで行う(固定IDを設定ファイルに書かない):
//   /notify here … 実行したテキストチャンネルを通知先にする
//   /notify off  … テキスト通知を止める
//   /join        … 実行者が今いるボイスチャンネルにBotを参加させる
//   /leave       … ボイスチャンネルから退出する
// テキスト通知先は .discord-bot-state.json に保存し、サーバ再起動をまたいで覚えておく。

import { readFileSync, writeFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCORD_FILE = path.join(__dirname, 'discord.json');
const STATE_FILE = path.join(__dirname, '.discord-bot-state.json');   // テキスト通知先の永続化

// 接続状態を1箇所に集約する(server.js からは直接触らせない)
const state = {
  client: null,        // Discord Client
  voice: null,         // @discordjs/voice モジュール(接続・再生で使う)
  connection: null,    // VoiceConnection(未接続なら null)
  player: null,        // AudioPlayer(再生を直列化する)
  textChannelId: '',   // テキスト通知先チャンネルID(/notify here で設定・未設定なら投稿しない)
};

// 設定を1項目読む: 環境変数が最優先、無ければ discord.json。
// discord.json.example のプレースホルダ(全角「（」で始まる説明文)はコピーしただけの未設定として扱う。
function readSetting(envValue, fileKey) {
  if (envValue) return envValue;
  try {
    const v = JSON.parse(readFileSync(DISCORD_FILE, 'utf8'))[fileKey];
    if (typeof v === 'string' && v && !v.startsWith('（')) return v;
  } catch { /* discord.json が無い/壊れていれば未設定として扱う */ }
  return '';
}

// このツールの唯一の資格情報。環境変数が最優先、無ければ discord.json の botToken。
function loadBotToken() {
  return readSetting(process.env.DISCORD_BOT_TOKEN, 'botToken');
}

// server.js が起動ログに「設定あり/未設定」を出すために使う。
// 実際にログインできたかどうかは initBot() が別途 [discord-bot] ログに出す。
export function isBotConfigured() {
  return Boolean(loadBotToken());
}

// テキスト通知先チャンネルIDを .discord-bot-state.json から読む(無ければ空)。
function loadTextChannelId() {
  try {
    const v = JSON.parse(readFileSync(STATE_FILE, 'utf8')).textChannelId;
    if (typeof v === 'string') return v;
  } catch { /* ファイルが無い/壊れていれば未設定として扱う */ }
  return '';
}

// テキスト通知先を保存する(投げっぱなし・失敗してもサーバは止めない)。
function saveTextChannelId(id) {
  writeFile(STATE_FILE, JSON.stringify({ textChannelId: id }, null, 2) + '\n', () => {});
}

// サーバ起動時に1回だけ呼ぶ。Bot Token が無ければ何もしない(discord.js を import すらしない)。
export async function initBot() {
  const botToken = loadBotToken();
  if (!botToken) return;   // 未設定: 依存ゼロのまま今まで通り

  // 設定があるときだけ動的import。npm install していなければここで失敗する。
  let discordjs, voice;
  try {
    discordjs = await import('discord.js');
    voice = await import('@discordjs/voice');
  } catch {
    console.log('[discord-bot] Discord Bot機能を使うには npm install が必要です(この機能を使わなければ不要)');
    return;   // 機能だけ無効化・本体は継続
  }

  state.voice = voice;
  state.textChannelId = loadTextChannelId();   // 前回の通知先を復元(/notify here を毎回打ち直さなくてよい)

  try {
    await login(discordjs, botToken);
    console.log('[discord-bot] ログインしました' + (state.textChannelId ? '(前回のテキスト通知先を復元)' : ''));
  } catch (e) {
    // トークン誤り・権限不足等。秘密は出さずメッセージだけログする。
    console.log('[discord-bot] ログインに失敗しました(機能は無効・本体は継続): ' + e.message);
    teardown();
  }
}

// login → ready → スラッシュコマンド登録 → コマンド待受 までを行う。
async function login(discordjs, botToken) {
  const { Client, GatewayIntentBits, Events } = discordjs;

  // 必要最小限のIntentだけ要求する(コマンド受信・ボイス接続に要る Guilds / GuildVoiceStates のみ。
  // メッセージ内容の読み取り等の特権Intentは要求しない)。
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  state.client = client;

  // ready のリスナを張ってから login する(先に張らないとイベントを取りこぼす可能性がある)。
  const ready = waitReady(client, Events);

  // 起動後に新しいサーバーへ招待された場合も、その場でコマンドを登録する(再起動なしで使える)。
  client.on(Events.GuildCreate, (guild) => {
    registerCommands(discordjs, guild).catch((e) =>
      console.log('[discord-bot] コマンド登録に失敗: ' + e.message));
  });

  // コマンドの実処理(スラッシュコマンド以外は無視)。
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    handleCommand(interaction).catch((e) =>
      console.log('[discord-bot] コマンド処理でエラー: ' + e.message));
  });

  await client.login(botToken);
  await ready;

  // 参加済みの全ギルドにコマンドを登録する。グローバル登録は反映に最大1時間かかるため、
  // ギルド(サーバー)単位で登録して即時に使えるようにする。
  for (const guild of client.guilds.cache.values()) {
    try {
      await registerCommands(discordjs, guild);
    } catch (e) {
      console.log('[discord-bot] コマンド登録に失敗: ' + e.message);
    }
  }
}

// スラッシュコマンド4つ(/notify here・/notify off・/join・/leave)をギルド単位で登録する。
function registerCommands(discordjs, guild) {
  const { SlashCommandBuilder } = discordjs;
  const commands = [
    new SlashCommandBuilder()
      .setName('notify')
      .setDescription('テキスト通知先を操作する')
      .addSubcommand((sub) => sub.setName('here').setDescription('このチャンネルを通知先にする'))
      .addSubcommand((sub) => sub.setName('off').setDescription('テキスト通知を止める')),
    new SlashCommandBuilder().setName('join').setDescription('自分が今いるボイスチャンネルにBotを呼ぶ'),
    new SlashCommandBuilder().setName('leave').setDescription('ボイスチャンネルから退出する'),
  ].map((c) => c.toJSON());
  return guild.commands.set(commands);
}

// スラッシュコマンドをコマンド名で振り分ける。
async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'notify': return handleNotify(interaction);
    case 'join':   return handleJoin(interaction);
    case 'leave':  return handleLeave(interaction);
  }
}

// /notify here … このチャンネルを通知先にする / /notify off … 通知を止める。
async function handleNotify(interaction) {
  if (interaction.options.getSubcommand() === 'here') {
    state.textChannelId = interaction.channelId;
    saveTextChannelId(state.textChannelId);   // 再起動をまたいで覚えておく
    await interaction.reply({ content: 'このチャンネルに通知します。', ephemeral: true });
    console.log('[discord-bot] テキスト通知先をこのチャンネルに設定しました');
    return;
  }
  // off
  state.textChannelId = '';
  saveTextChannelId('');
  await interaction.reply({ content: 'テキスト通知を停止しました。', ephemeral: true });
  console.log('[discord-bot] テキスト通知を停止しました');
}

// /join … 実行者が今いるボイスチャンネルにBotを参加させる。
async function handleJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({ content: '先にボイスチャンネルに参加してください。', ephemeral: true });
    return;
  }
  // 接続には数秒かかりうるので、先に defer して「考え中」を出しておく(3秒の応答期限を回避)。
  await interaction.deferReply({ ephemeral: true });
  try {
    await joinChannel(voiceChannel);
    await interaction.editReply('ボイスチャンネルに参加しました。');
    console.log('[discord-bot] ボイスチャンネルに参加しました');
  } catch (e) {
    await interaction.editReply('ボイスチャンネルへの参加に失敗しました。');
    console.log('[discord-bot] ボイスチャンネルへの参加に失敗しました: ' + e.message);
  }
}

// /leave … 接続中のボイスチャンネルから退出する。
async function handleLeave(interaction) {
  if (!state.connection) {
    await interaction.reply({ content: 'ボイスチャンネルに参加していません。', ephemeral: true });
    return;
  }
  leaveChannel();
  await interaction.reply({ content: 'ボイスチャンネルから退出しました。', ephemeral: true });
  console.log('[discord-bot] ボイスチャンネルから退出しました');
}

// 指定のボイスチャンネルに参加し、AudioPlayerを購読する。既に別のVCにいれば入り直す。
async function joinChannel(channel) {
  const {
    joinVoiceChannel, createAudioPlayer, entersState,
    VoiceConnectionStatus, NoSubscriberBehavior,
  } = state.voice;

  // 既存の接続があれば破棄してから新しいチャンネルに入り直す。
  if (state.connection) {
    try { state.connection.destroy(); } catch { /* 破棄済みなら無視 */ }
    state.connection = null;
    state.player = null;
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
      // 戻らなければ本当に切れたとみなして破棄する(再参加は /join で行う)。
      try { connection.destroy(); } catch { /* 破棄済みなら無視 */ }
      // 既に別のチャンネルへ入り直していれば新しい接続を消さない。
      if (state.connection === connection) { state.connection = null; state.player = null; }
      console.log('[discord-bot] ボイスチャンネルから切断されました(再参加は /join で)');
    }
  });
}

// ボイスチャンネルから退出する。以降 playInVoice() は no-op になる。
function leaveChannel() {
  try { state.connection?.destroy(); } catch { /* 破棄済みなら無視 */ }
  state.connection = null;
  state.player = null;
}

// ClientReady を待つ(login後に喋れる状態になるのを待つ)。一定時間で諦める。
function waitReady(client, Events) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ログイン後の準備がタイムアウトしました')), 15_000);
    client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
    client.once(Events.Error, (e) => { clearTimeout(timer); reject(e); });
  });
}

// 保存済みのテキスト通知先チャンネルへ投稿する(投げっぱなし・失敗してもサーバは止めない)。
// 未設定(/notify here 未実行)/未ログインなら何もしない(no-op)。
export function sendText(text) {
  const { client, textChannelId } = state;
  if (!client || !textChannelId) return;   // 未設定/未ログイン: 何もしない
  (async () => {
    try {
      const channel = await client.channels.fetch(textChannelId);
      if (channel && channel.isTextBased()) await channel.send(text);
    } catch (e) {
      console.log('[discord-bot] テキスト通知に失敗: ' + e.message);
    }
  })();
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
    const onError = (e) => { console.log('[discord-bot] ボイス再生でエラー: ' + e.message); finish(); };

    try {
      // play() の前にリスナを張り、短い音声でも完了イベント(Idle)を取りこぼさないようにする。
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
      timer = setTimeout(finish, 60_000);                // 万一Idleが来なくても60秒で諦める(呼び出し側を待たせ続けない)
      player.play(createAudioResource(filePath));
    } catch (e) {
      console.log('[discord-bot] ボイス再生の開始に失敗: ' + e.message);
      finish();
    }
  });
}

// ログインに失敗した/破棄するときの後始末。以降 sendText() / playInVoice() は no-op になる。
function teardown() {
  try { state.connection?.destroy(); } catch { /* 破棄済みなら無視 */ }
  try { Promise.resolve(state.client?.destroy?.()).catch(() => {}); } catch { /* 無視 */ }
  state.client = null;
  state.voice = null;
  state.connection = null;
  state.player = null;
  // textChannelId は永続化した設定なので消さない(次回起動で復元する)。
}
