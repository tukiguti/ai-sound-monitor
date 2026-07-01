# AI活用記録（prompts.md）

情報論PBLの要件どおり、AIに依頼した内容・AIの出力・自分で確認/修正した点を残す。
「AIがこう言った」ではなく「AIはAと出したが、確認してBに直した」を書くのが目的。

---

## P0（第11回）: 1ターミナル → web → 音

### AIへの依頼（要旨）
- テーマ: 複数AIの同時運用を音で伝える
- 最終目標: VOICEVOXで「〇〇版が承認待ち/完了です」と読み上げ ＋ Discord通知
- 今日の最小構成: 1つのターミナルから、web版を通して音を鳴らす
- 制約（軽量重視）: サーバはNode標準機能のみ（npm install不要）

### AIの出力
- 依存ゼロのNodeサーバ（`server.js`）: `/events`(SSE) と `/notify`(POST/GET) と静的配信
- 受信ダッシュボード（`public/`）: 状態ごとの音（Web Audio）＋受信ログ
- `curl` でイベントを送ると音が鳴る構成

### 自分で確認 / 修正した点
- （記入する）例: ブラウザの自動再生制限で、最初に「音を有効にする」を押さないと鳴らなかった → 一度クリックで解禁する仕様を確認
- （記入する）状態ごとの音が区別しやすいか、実際に聴いて調整したか
- （記入する）curlで実際に鳴ったか、鳴らなかった場合どこで詰まったか

---

## P1（第12回・予定）: 複数AI × 状態 / Claude Code hook

- Claude Code の `Stop` hook → `curl .../notify?state=done` を実行させる
- `Notification` hook → `state=waiting`（承認待ち）

### 実施済み（2026-07-01）: hook設定を追加
- `.claude/settings.json`（このプロジェクト限定）に `Stop`→done、`Notification`→waiting を設定
- 非ブロッキング（バックグラウンド＋`-m 1`＋`|| 失敗しても無視`）、`CLAUDE_PROJECT_DIR`のbasenameを`ai`名に
- コマンド単体をpipe-testで検証（`ai=ai-sound-monitor`で届くこと、未設定時は`Claude`にフォールバック）
- `jq -e` で JSON構文・hookスキーマを検証（Stop/Notificationとも exit=0）
- 実発火の確認：**このディレクトリで新しいClaude Codeセッションを開いて**行う（zikkenセッションでは読まれない）
- ✅ 2026-07-01 実発火を確認：ai-sound-monitorで開いたセッションが応答完了時に完了音を鳴らした

---

## P2（発展・予定）: VOICEVOX / Discord

- VOICEVOX ENGINE（localhost:50021）を server 経由で叩き、読み上げ音声を再生
- Discord Incoming Webhook にイベントを投稿
- （依頼・出力・修正をここに追記）
