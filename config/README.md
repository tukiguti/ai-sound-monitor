# config/ — ユーザーが編集する設定はここだけ

このフォルダの3ファイルを編集すれば設定は完結する。コード(`lib/`)・テンプレート(`examples/`)・実行時状態(`.data/`)には触らなくてよい。

| ファイル | 内容 | 反映タイミング |
|---|---|---|
| `config.json` | 音の設定(`voice.speaker` / `voice.volume` / `voice.speed`・`chime.volume`)＋通知の閾値(`notify.quietSeconds`＝この秒数未満の短いターンでは読み上げ・Discord通知を抑制。0で無効=毎回鳴る) | サーバ再起動(`chime.volume` はブラウザ再読み込みも。`notify.quietSeconds` は再起動のみ)。Discord が使えるなら `/voice set` でも変更可(再起動不要) |
| `names.json` | ディレクトリ名 → 表示名/読み名。未登録は自動追記される | サーバ再起動。`/name set` でも変更可(再起動不要) |
| `discord.json` | Discord Bot Token(このツール唯一の秘密・gitignore 済み) | サーバ再起動 |

## discord.json の作り方

```bash
cp discord.json.example discord.json
# discord.json を開いて botToken に Token を貼る
```

`discord.json` は gitignore 済みでコミットされない。Bot 機能を使わないなら作らなくてよい。
