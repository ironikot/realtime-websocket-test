# Live API リアルタイム会話テストアプリ

lives-api-server の Gemini Live 中継エンドポイント（`/gemini-md`）に接続し、
**マイク音声 + カメラ映像（1FPS）のリアルタイム・マルチモーダル会話**をスマホで試すためのテスト用Webアプリ。
iOS チームに依頼する前の挙動確認用。

## 使い方

1. スマホ（または PC）のブラウザで GitHub Pages の URL を開く
2. APIキー欄に **APIサーバーの API_KEY** を入力（端末の localStorage にのみ保存される）
3. 「🎙 セッション開始」→ マイクとカメラを許可
4. カメラに何かを映しながら話しかける（例:「いま何が見えてる？」「ペンが映ったら教えて」）

## 何が確認できるか

- **リアルタイム音声会話**: 話しかけると AI が音声で即答。会話への割り込み（barge-in）も可
- **映像のリアルタイム理解**: カメラ映像を 1FPS で送信し続けるので、「いま見えているもの」を前提に会話できる
- **能動的な通知**: 「○○が映ったら教えて」と頼めば、映った時点で AI から発話する
- **長時間セッション**: context window compression 有効のため時間無制限。古い記憶はスライディングウィンドウで自然に消える
- **自動再接続と記憶の引き継ぎ**: 接続は約10分で切れるが、resumption ハンドルで自動再接続し会話の記憶を維持する（画面の 🔁 が再接続回数）
- **コスト目安**: 画面に概算（音声入力 $0.005/分 + 映像 $0.002/分 + 音声出力 $0.018/分、USDJPY=161 換算）をリアルタイム表示

## 接続先

- 既定: dev 環境 `wss://lives-api-server-dev-96368391213.asia-northeast1.run.app/gemini-md`
- モデル: `gemini-live-2.5-flash-native-audio`（サーバー側 `GEMINI_LIVE_MODEL` env で変更可能）

## プロトコル（サーバー中継との約束事）

```
クライアント → サーバー:
  1. {"api_key": "<API_KEY>"}                        … 認証（最初の1通）
  2. {"config": {"response_modalities": ["AUDIO"],
                 "system_instruction": "...",
                 "resumption_handle": "<再接続時のみ>"}}
  3. {"realtime_input": {"media_chunks": [
        {"mime_type": "audio/pcm",  "data": "<16kHz PCM16 base64>"},
        {"mime_type": "image/jpeg", "data": "<JPEG base64>"}]}}

サーバー → クライアント（Vertex AI の応答をそのまま中継）:
  - {"setupComplete": ...}
  - {"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": "<24kHz PCM16>"}}]}}}
  - {"serverContent": {"inputTranscription"/"outputTranscription": {"text": "..."}}}
  - {"serverContent": {"interrupted": true}}         … barge-in（再生キューを破棄する）
  - {"sessionResumptionUpdate": {"resumable": true, "newHandle": "..."}}  … 保存して再接続時に使う
  - {"goAway": ...}                                  … 接続寿命の予告
```

## 注意

- GitHub Pages は静的ホスティングのみ。APIキーはページに埋め込まず、利用者が入力する
- iOS Safari は音声再生にユーザー操作起点が必要なため、セッション開始はボタンタップから
- 画面ロックすると getUserMedia が止まる（Wake Lock 対応端末では自動でスリープ抑止）
