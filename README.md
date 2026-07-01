# AI Sound Monitor（AI音モニター）

複数のAI（Claude Code など）を同時に走らせているとき、どのAIが「完了」「承認待ち」「エラー」になったかを、**画面を見張らずに音で気づく**ためのツール。

情報論 2026 第11回 アプリ開発PBL の成果物。

## 目的

複数ターミナルでAIを並行運用すると、状態変化に気づけず切り替えのタイミングを逃す。
ターミナルの出来事を Web ページに中継し、**状態ごとの音**で知らせる。

## 全体像

```
[ターミナルのAI]        [ローカルサーバ]           [Webページ(ブラウザ)]
 Claude Code 等  ──①──▶ ・ページ配信              ・状態を表示
 Stop/Notification       ・/notify で受信 ──②──▶  ・状態ごとの音を再生
 hook / curl             ・ブラウザへ中継(SSE)      (発展) VOICEVOX読み上げ
```

## 使い方

前提: Node.js（外部パッケージのインストールは不要）。

```bash
# 1. サーバを起動
npm start          # または: node server.js

# 2. ブラウザで開く
open http://localhost:4123
#    → 右上「🔊 音を有効にする」を一度クリック（ブラウザの音解禁のため）

# 3. 別のターミナルからイベントを送る → 音が鳴る
curl "http://localhost:4123/notify?state=done&ai=リサーチ版"
```

`state` は `done`（完了）/ `waiting`（承認待ち）/ `error`（エラー）/ `working`（実行中）。
`ai` は表示名、`message` は補足メッセージ（任意）。

## 現在できること

- [x] ローカルサーバがイベントを受けてブラウザへ中継（SSE）
- [x] 状態ごとに区別できる音を再生（Web Audio API・音源ファイル不要）
- [x] 受信ログの表示
- [x] Claude Code の Stop / Notification hook を設定（`.claude/settings.json`）※このディレクトリでセッションを開くと発火（実発火は要動作確認）
- [ ] 複数AIの状態を区別してダッシュボード表示（P1）
- [ ] VOICEVOX で「〇〇版が承認待ちです」と読み上げ（P2）
- [ ] Discord 通知（P2）

## 動作確認

サーバ起動後、`curl "http://localhost:4123/notify?state=done&ai=test"` を実行すると、
ブラウザの受信ログに1件追加され、完了音が鳴る（音は「音を有効にする」を押した後）。

## 検証（第13回で示す予定）

- 画面を見ずに、音だけで「どの状態か」を当てられるか（正答率）
- 画面監視 vs 音通知で「状態変化に気づくまでの時間」がどれだけ短縮されるか

## AI活用記録

`prompts.md` を参照。

## 技術

- サーバ: Node.js 標準 `http` のみ（依存ゼロ / SSE で push）
- 画面: HTML / CSS / JavaScript（Web Audio API）
