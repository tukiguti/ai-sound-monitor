# AI Sound Monitor（AI音モニター）

複数のAI（Claude Code など）を同時に走らせているとき、どのAIが「完了」「承認待ち」「エラー」になったかを、**画面を見張らずに 音・声・Discord通知 で気づく**ためのツール。


## 全体像

```
[ターミナルのAI]         [ローカルサーバ :4123]         [受け取る側]
 Claude Code の hook ──▶  ・イベント受信(/notify)   ──▶  ブラウザ: 盤面表示＋チャイム音
 または curl              ・各AIの現在状態を保持    ──▶  VOICEVOX→afplay: 「〇〇が完了です」
                          ・SSEでブラウザへ中継     ──▶  Discord: ✅完了/⏳承認待ち/⛔エラー
```

---

## 設定（初回のみ）

前提: macOS / Node.js（**外部パッケージのインストールは不要**）

### 1. クローン

```bash
git clone https://github.com/tukiguti/ai-sound-monitor.git
cd ai-sound-monitor
```

### 2. Claude Code に hook を入れる

hook のテンプレートが `claude-hooks.example.json` にある。入れ方は2通り:

**(a) 全プロジェクトを監視する（推奨・複数AI同時運用の本来の姿）**

`~/.claude/settings.json` の `hooks` に、テンプレートの4イベント（UserPromptSubmit / Stop / Notification / SessionEnd）をマージする。
既に他の hook がある場合は、同じイベントの `hooks` 配列に**追記**すれば共存できる。

**(b) 特定のプロジェクトだけ監視する**

```bash
# 例: ~/GitHub/myproject を監視対象にする
mkdir -p ~/GitHub/myproject/.claude
cp claude-hooks.example.json ~/GitHub/myproject/.claude/settings.json
```

コピー先に既に `.claude/settings.json` がある場合は `hooks` の中身を手動でマージする。

**共通の注意**

- (a)と(b)を同じプロジェクトに重ねると**二重通知**になる（グローバルとプロジェクトの hook は両方実行されるため）。どちらか片方にする
- hook は非ブロッキング（1秒タイムアウト・失敗無視）なので、**サーバを起動していない日でも Claude Code の動作に影響しない**
- 設定を入れた後に**新しく開いた**セッションから有効になる

### 3. VOICEVOX（任意・喋らせたい場合）

[VOICEVOX](https://voicevox.hiroshiba.jp/) をインストールするだけ。話者は既定で 冥鳴ひまり。声や音量は `config.json` で変更できる(下記)。

### 音の調整（config.json）

`config.json` の数値を書き換えて**サーバ再起動**で反映（チャイム音量はブラウザ再読み込みも）:

| キー | 意味 | 例 |
|---|---|---|
| `voice.speaker` | 読み上げの話者ID（2=四国めたん / 3=ずんだもん / 8=春日部つむぎ / 13=青山龍星 / 14=冥鳴ひまり） | `3` |
| `voice.volume` | 読み上げの音量（1.0=標準） | `1.5` |
| `voice.speed` | 読み上げの速さ（1.0=標準） | `1.2` |
| `chime.volume` | チャイム音量の倍率（0で消音） | `0.5` |

話者IDの全一覧: `curl -s http://localhost:50021/speakers | jq -r '.[] | .name as $n | .styles[] | "\(.id)=\($n)（\(.name)）"'`

### 4. Discord通知（任意・スマホでも気づきたい場合）

1. Discord の サーバ設定 → 連携サービス → ウェブフック → 新しいウェブフック → URL をコピー
2. テンプレートをコピーして URL を書き換える:

```bash
cp discord.json.example discord.json
# discord.json を開いて webhookUrl に貼り付ける
```

`discord.json` は **gitignore 済みでコミットされない**。環境変数 `DISCORD_WEBHOOK_URL` でも設定できる（そちらが優先）。未設定なら通知は無効のまま普通に動く。

### 5. 名前マップ（任意・あとからでOK）

`names.json` に ディレクトリ名 → 表示名 を書くと、盤面と読み上げの両方に使われる:

```json
{
  "ai-sound-monitor": "サウンドモニター"
}
```

未登録のプロジェクトからイベントが届くと **names.json に自動で追記される**ので、あとから値（読み名）を書き換えるだけでよい。変更はサーバ再起動で反映。

---

## 使い方（毎回）

### 1. サーバを起動

```bash
cd ai-sound-monitor
node server.js        # または npm start
```

起動ログに `Discord : 通知有効/未設定` が表示される。

### 2. VOICEVOX ENGINE を起動（喋らせたい場合のみ）

```bash
/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run   # ヘッドレス起動
# （VOICEVOXアプリを普通に開いてもよい）
```

未起動でも読み上げが自動スキップされるだけで、チャイム音とDiscordは動く。

### 3. ブラウザで盤面を開く

```bash
open http://localhost:4123
```

右上の **「🔊 音を有効にする」を一度クリック**（ブラウザの自動再生制限の解禁。読み上げとDiscordはブラウザを開いていなくても動く）。

### 4. あとは監視対象のプロジェクトで Claude Code を使うだけ

セッションが「プロジェクト名#セッションID」として自動で盤面に載り、状態に応じて通知される:

| Claude Code の動き | state | チャイム音 | 読み上げ | Discord |
|---|---|---|---|---|
| 指示を送った | 🔄 実行中 | 小さなティック | — | — |
| 承認・入力待ちで停止 | ⏳ 承認待ち | 2連ビープ | 「〇〇が承認待ちです」 | ⏳ 投稿 |
| 応答が完了 | ✅ 完了 | 上昇チャイム | 「〇〇が完了です」 | ✅ 投稿 |
| （手動送信のみ）エラー | ⛔ エラー | 下降ブザー | — | ⛔ 投稿 |
| セッション終了 | — | — | — | 盤面から自動削除 |

- 同じプロジェクトを複数開いているときだけ「〇〇**の2番**が完了です」と番号で区別される
- 音がうるさい状態は、盤面の凡例のチェックで**状態ごとに消音**できる（ブラウザに保存）

### 5. 手動でイベントを送る（curl / 他ツール連携）

```bash
curl -G "http://localhost:4123/notify" \
  --data-urlencode state=done \
  --data-urlencode ai=リサーチ版 \
  --data-urlencode "message=論文調査おわり"
```

`state` = `working` / `waiting` / `done` / `error` / `ended`（endedは盤面から削除）。
**日本語をURLに直書きしない**こと（`--data-urlencode` を使う）。

### 終了するとき

```bash
pkill -f "node server.js"   # サーバ停止
pkill -f vv-engine          # VOICEVOX ENGINE停止（使っていた場合）
```

盤面は `.state.json` に保存されているので、次回起動時に復元される。
古い表示を消したいときは、画面の「一覧をクリア」か `curl http://localhost:4123/clear`。

---

## リファレンス

### エンドポイント

| パス | 用途 |
|---|---|
| `/` | ダッシュボード画面 |
| `/notify` | イベント受信（GET / POST）。ターミナルや hook から叩く |
| `/events` | ブラウザ向け SSE。接続時に現在の盤面（スナップショット）を送る |
| `/clear` | 監視中AIの一覧をリセット（受信ログは消えない） |
| `/config` | ブラウザ向けの音設定（チャイム音量）を返す |

### 機能一覧

- [x] ローカルサーバがイベントを受けてブラウザへ中継（SSE）＋現在状態を保持（後から開いても盤面が見える）
- [x] 状態ごとに区別できるチャイム音（Web Audio API・音源ファイル不要）＋状態ごとの音ON/OFF
- [x] Claude Code hook 連携 — UserPromptSubmit=実行中 / Stop=完了 / Notification=承認待ち / SessionEnd=盤面から削除
- [x] セッション単位の監視 — 同一プロジェクトの複数セッションも別々に追跡、終了時に自動削除
- [x] 盤面の永続化（`.state.json`）— サーバ再起動後も復元
- [x] VOICEVOX 読み上げ — サーバ側(afplay)再生なのでブラウザ不要。ENGINE未起動なら自動スキップ
- [x] 名前マップ（`names.json`・未登録は自動追記）＋同名複数時のみ番号読み
- [x] Discord 通知 — 完了/承認待ち/エラーをWebhookに投稿（URLはコミット対象外）

### ドキュメント

- [docs/設計.md](docs/設計.md) — 全体構成・状態モデル・API・設計判断の理由・既知の制約
- [prompts.md](prompts.md) — AI活用記録（依頼・出力・検証して直した点）

### 技術

- サーバ: Node.js 標準 `http` のみ（依存ゼロ / SSE で push / macOS前提=afplay）
- 画面: HTML / CSS / JavaScript（Web Audio API）

### 検証（発表で示す予定）

- 画面を見ずに、音だけで「どの状態か」を当てられるか（正答率）
- 画面監視 vs 音通知で「状態変化に気づくまでの時間」がどれだけ短縮されるか
