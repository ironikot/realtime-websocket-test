/*
 * live.js — /api/v2/live（Gemini Live 終端型プロキシ）のテストクライアント。
 *
 * プロトコル（サーバー側 api/live/protocol.py が仕様書）:
 *   - バイナリ 8B ヘッダ (LE): version u8=1 / type u8 / flags u16 / seq u32
 *     type: 0x01 audio_batch(C→S, Opus 24k 20ms×≤5) / 0x02 video_frame(JPEG)
 *           0x11 audio_batch(S→C, Opus 48k 20ms×≤5, flags bit0=end_of_turn)
 *     audio payload: count u8 + { len u16 LE + opus packet } × count
 *   - テキスト JSON: auth → auth_ok → start → ready → 各種イベント
 *
 * 音声は WebCodecs (AudioEncoder/AudioDecoder) を使用。Chrome / Edge 専用。
 * 再接続チェーン: reconnect_hint / 予期しない切断 → resumption_handle 付き start で
 * break-before-make 再接続（会話の記憶はサーバー側 Gemini セッションが維持）。
 */
"use strict";

// ---------- 定数 ----------
const PROTO_VERSION = 1;
const TYPE_AUDIO_IN = 0x01;
const TYPE_VIDEO = 0x02;
const TYPE_DEPTH = 0x03;
const TYPE_AUDIO_OUT = 0x11;
const FLAG_END_OF_TURN = 0x0001;
const BATCH_PACKETS = 5;          // 20ms × 5 = 100ms / メッセージ
const VIDEO_FPS = 1;
// 解像度は実デバイスのカメラ性能に合わせてクライアント側で決める（サーバーは素通しで
// 何 px でも受ける）。参考: IMAGE トークンは解像度に関係なく 258/フレーム固定（2026-08-29 実測）
const VIDEO_MAX_SIDE = 640;
const VIDEO_JPEG_Q = 0.7;
const OPUS_BITRATE = 32000;
const PENDING_PACKETS_MAX = 100;  // 再接続中の送信バッファ（約 2 秒）

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const badge = $("conn-badge");
const transcriptEl = $("transcript");
const toolBanner = $("tool-banner");

function setBadge(text, cls) { badge.textContent = text; badge.className = "badge " + cls; }

// 会話ログ。transcription は断片で届くため、ターンが変わるまで同じ行に足し込む
// （1 断片 = 1 行にするとログが縦に爆発してすぐ見えなくなる）。
const currentLine = { user: null, ai: null };

function addLine(role, text, cls) {
  const div = document.createElement("div");
  div.className = "line " + (cls || role);
  div.textContent = (role === "user" ? "🗣 " : role === "ai" ? "🤖 " : "ℹ️ ") + text;
  transcriptEl.appendChild(div);
  currentLine.user = null;  // sys 行を挟んだら次の断片は新しい行から
  currentLine.ai = null;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendTranscript(role, text) {
  let el = currentLine[role];
  if (!el) {
    el = document.createElement("div");
    el.className = "line " + role;
    el.textContent = role === "user" ? "🗣 " : "🤖 ";
    transcriptEl.appendChild(el);
    currentLine[role] = el;
  }
  el.textContent += text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeTurnLines() {
  currentLine.user = null;
  currentLine.ai = null;
}

// ---------- プロトコル encode/decode ----------
function encodeFrame(type, seq, payload, flags = 0) {
  const buf = new ArrayBuffer(8 + payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, PROTO_VERSION);
  dv.setUint8(1, type);
  dv.setUint16(2, flags, true);
  dv.setUint32(4, seq >>> 0, true);
  new Uint8Array(buf, 8).set(new Uint8Array(payload.buffer || payload, payload.byteOffset || 0, payload.byteLength));
  return buf;
}

function encodeAudioPayload(packets) {
  let total = 1;
  for (const p of packets) total += 2 + p.byteLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, packets.length);
  let pos = 1;
  for (const p of packets) {
    dv.setUint16(pos, p.byteLength, true); pos += 2;
    u8.set(p, pos); pos += p.byteLength;
  }
  return buf;
}

function decodeAudioOut(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 9) return null;
  if (dv.getUint8(0) !== PROTO_VERSION || dv.getUint8(1) !== TYPE_AUDIO_OUT) return null;
  const flags = dv.getUint16(2, true);
  const seq = dv.getUint32(4, true);
  const count = dv.getUint8(8);
  const packets = [];
  let pos = 9;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(pos, true); pos += 2;
    packets.push(new Uint8Array(arrayBuffer, pos, len)); pos += len;
  }
  return { seq, packets, endOfTurn: !!(flags & FLAG_END_OF_TURN) };
}

// ---------- アプリ状態 ----------
const app = {
  running: false,
  ws: null,
  wsGeneration: 0,
  resumptionHandle: null,
  reconnects: 0,
  // メディア
  captureCtx: null, playbackCtx: null,
  encoder: null, decoder: null,
  encoderRate: 24000,
  micStream: null, camStream: null,
  workletNode: null,
  depthBytes: null,
  // 送信
  audioSeq: 0, videoSeq: 0,
  packetQueue: [],           // エンコード済み Opus（バッチ待ち + 再接続バッファ）
  // 再生
  nextPlayTime: 0, playingSources: new Set(), decodeTimestamp: 0,
  // 統計
  startedAt: 0, framesSent: 0, audioMsSent: 0, batchesReceived: 0,
  statTimer: null, videoTimer: null,
};

// ---------- サポート確認 ----------
async function checkSupport() {
  if (!("AudioEncoder" in window) || !("AudioDecoder" in window)) {
    return "このブラウザは WebCodecs 非対応です（PC は Chrome / Edge、スマホは Android Chrome を使ってください。iPhone は iOS を最新にすると動く場合があります）";
  }
  const enc = await AudioEncoder.isConfigSupported({
    codec: "opus", sampleRate: 24000, numberOfChannels: 1, bitrate: OPUS_BITRATE,
  }).catch(() => ({ supported: false }));
  const dec = await AudioDecoder.isConfigSupported({
    codec: "opus", sampleRate: 48000, numberOfChannels: 1,
  }).catch(() => ({ supported: false }));
  if (!dec.supported) return "Opus 48kHz デコードが利用できません";
  if (!enc.supported) return "Opus 24kHz エンコードが利用できません";
  return null;
}

// ---------- 音声キャプチャ（24kHz → Opus 20ms） ----------
const workletCode = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

async function startCapture() {
  app.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  try {
    app.captureCtx = new AudioContext({ sampleRate: 24000 });
  } catch (e) {
    app.captureCtx = new AudioContext(); // 環境が 24k を拒否したら実レートで（サーバーはレート非依存で復号可能）
  }
  app.encoderRate = app.captureCtx.sampleRate;
  const frameSamples = Math.round(app.encoderRate * 0.02);

  app.encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      enqueuePacket(data);
    },
    error: (e) => addLine("sys", "encoder error: " + e.message, "sys"),
  });
  app.encoder.configure({
    codec: "opus", sampleRate: app.encoderRate, numberOfChannels: 1,
    bitrate: OPUS_BITRATE, opus: { frameDuration: 20000 },
  });

  const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
  await app.captureCtx.audioWorklet.addModule(blobUrl);
  const src = app.captureCtx.createMediaStreamSource(app.micStream);
  app.workletNode = new AudioWorkletNode(app.captureCtx, "capture-processor");
  src.connect(app.workletNode);

  let acc = new Float32Array(0);
  let sampleCount = 0;
  app.workletNode.port.onmessage = (ev) => {
    const chunk = ev.data;
    const merged = new Float32Array(acc.length + chunk.length);
    merged.set(acc); merged.set(chunk, acc.length);
    acc = merged;
    while (acc.length >= frameSamples) {
      const frame = acc.subarray(0, frameSamples);
      const pcm = new Int16Array(frameSamples);
      for (let i = 0; i < frameSamples; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const audioData = new AudioData({
        format: "s16", sampleRate: app.encoderRate, numberOfFrames: frameSamples,
        numberOfChannels: 1, timestamp: Math.round(sampleCount * 1e6 / app.encoderRate),
        data: pcm,
      });
      sampleCount += frameSamples;
      if (app.encoder.state === "configured") app.encoder.encode(audioData);
      audioData.close();
      acc = acc.slice(frameSamples);
    }
  };
}

function enqueuePacket(bytes) {
  app.packetQueue.push(bytes);
  while (app.packetQueue.length > PENDING_PACKETS_MAX) app.packetQueue.shift(); // 再接続中は古い方から捨てる
  flushPackets();
}

function flushPackets() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN || !app.ready) return;
  while (app.packetQueue.length >= BATCH_PACKETS) {
    const batch = app.packetQueue.splice(0, BATCH_PACKETS);
    const payload = new Uint8Array(encodeAudioPayload(batch));
    app.ws.send(encodeFrame(TYPE_AUDIO_IN, app.audioSeq++, payload));
    app.audioMsSent += BATCH_PACKETS * 20;
  }
}

// ---------- 再生（Opus 48kHz） ----------
function setupPlayback() {
  app.playbackCtx = new AudioContext({ sampleRate: 48000 });
  app.nextPlayTime = 0;
  app.decodeTimestamp = 0;
  app.decoder = new AudioDecoder({
    output: (audioData) => {
      const n = audioData.numberOfFrames;
      const f32 = new Float32Array(n);
      audioData.copyTo(f32, { planeIndex: 0, format: "f32-planar" });
      audioData.close();
      const buf = app.playbackCtx.createBuffer(1, n, 48000);
      buf.getChannelData(0).set(f32);
      const srcNode = app.playbackCtx.createBufferSource();
      srcNode.buffer = buf;
      srcNode.connect(app.playbackCtx.destination);
      const now = app.playbackCtx.currentTime;
      const startAt = Math.max(now + 0.02, app.nextPlayTime);
      srcNode.start(startAt);
      app.nextPlayTime = startAt + buf.duration;
      app.playingSources.add(srcNode);
      srcNode.onended = () => app.playingSources.delete(srcNode);
    },
    error: (e) => addLine("sys", "decoder error: " + e.message, "sys"),
  });
  app.decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
}

function stopPlaybackNow() {
  for (const s of app.playingSources) { try { s.stop(); } catch (e) {} }
  app.playingSources.clear();
  app.nextPlayTime = 0;
  // デコーダ内の未出力もリセット
  try { app.decoder.reset(); app.decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 }); } catch (e) {}
}

// ---------- カメラ（1FPS JPEG バイナリ） ----------
async function startCamera() {
  app.camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 } },
  });
  const video = $("camera-preview");
  video.srcObject = app.camStream;
  const canvas = $("capture-canvas");
  app.videoTimer = setInterval(async () => {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN || !app.ready) return;
    if (!video.videoWidth) return;
    const scale = VIDEO_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight);
    canvas.width = Math.round(video.videoWidth * Math.min(1, scale));
    canvas.height = Math.round(video.videoHeight * Math.min(1, scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", VIDEO_JPEG_Q));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const seq = app.videoSeq++;
    app.ws.send(encodeFrame(TYPE_VIDEO, seq, bytes));
    if (app.depthBytes) {
      // テスト用: 選択した深度 PNG を映像と同じ連番で毎フレーム送る（実機は LiDAR 由来）
      app.ws.send(encodeFrame(TYPE_DEPTH, seq, app.depthBytes));
    }
    app.framesSent++;
    showSentFrame(blob, seq, canvas.width, canvas.height, bytes.byteLength);
  }, 1000 / VIDEO_FPS);
}

// 実際に送信した JPEG（バイナリフレームのペイロードそのもの）を並べて表示する。
// プレビュー <video> は CSS 都合の見え方であり、送信内容の確認はこちらが正。
// 直近フレームは seq で保持し、watch_result の video_seq から検出フレームを引けるようにする
const recentFrames = new Map(); // seq -> Blob
function showSentFrame(blob, seq, w, h, byteLength) {
  const img = $("sent-preview");
  const url = URL.createObjectURL(blob);
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.src = url;
  img.dataset.url = url;
  recentFrames.set(seq, blob);
  for (const k of recentFrames.keys()) {
    if (recentFrames.size <= 12) break;
    recentFrames.delete(k);
  }
  $("sent-info").textContent =
    `seq=${seq} / ${w}×${h}px / ${(byteLength / 1024).toFixed(1)}KB / JPEG q${VIDEO_JPEG_Q} / ${VIDEO_FPS}FPS`;
}

// ---------- 見張り（start_object_search）パネル ----------
function setWatchStatus(text, isHit) {
  $("watch-panel").classList.remove("hidden");
  $("watch-panel").classList.toggle("hit", !!isHit);
  $("watch-status").textContent = text;
}

// 発見位置を、検出に使ったフレームへ赤枠で描いて表示する。
// サーバーも同じ画像を GCS live_watch/ に保存している（デバッグの正はそちら）。
async function showWatchHit(msg) {
  const objects = msg.objects || [];
  const labels = objects.map((o) => o.label).filter(Boolean);
  const title = `🔴 発見: ${labels.join("、") || (msg.targets || []).join("、") || "対象"}`;
  setWatchStatus(title, true);
  addLine("sys", `${title}${msg.summary ? "（" + msg.summary + "）" : ""}`, "sys");
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]); // iOS は非対応（無視される）

  // 位置・距離のテキスト詳細（画像が引けない場合でも最低限これは出す）
  const detail = objects.map((o) => {
    const parts = [o.label];
    if (o.clock_position != null) parts.push(`${o.clock_position}時方向`);
    if (o.vertical) parts.push(o.vertical);
    if (o.distance_m != null) parts.push(`約${o.distance_m}m`);
    return parts.filter(Boolean).join(" ");
  }).join(" / ");
  $("watch-hit-detail").textContent = detail ? `${detail}（seq=${msg.video_seq ?? "-"}）` : "";
  $("watch-hit-detail").classList.toggle("hidden", !detail);

  const blob = recentFrames.get(msg.video_seq);
  if (!blob || objects.length === 0) { $("watch-hit-img").classList.add("hidden"); return; }
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  ctx.strokeStyle = "#f00";
  ctx.fillStyle = "#f00";
  ctx.lineWidth = 4;
  ctx.font = "16px sans-serif";
  const box = Math.max(24, Math.min(bmp.width, bmp.height) * 0.12);
  for (const obj of objects) {
    const [px, py] = obj.point || [];
    if (px == null) continue;
    const x = px * bmp.width, y = py * bmp.height;
    ctx.strokeRect(x - box / 2, y - box / 2, box, box);
    if (obj.label) ctx.fillText(obj.label, x - box / 2, Math.max(14, y - box / 2 - 6));
  }
  $("watch-hit-img").src = canvas.toDataURL("image/jpeg", 0.85);
  $("watch-hit-img").classList.remove("hidden");
}

// ---------- WebSocket 接続（再接続チェーン対応） ----------
function connect() {
  const gen = ++app.wsGeneration;
  app.ready = false;
  setBadge(app.reconnects ? `再接続中(${app.reconnects})` : "接続中…", "connecting");
  const ws = new WebSocket($("ws-url").value.trim());
  ws.binaryType = "arraybuffer";
  app.ws = ws;

  ws.onopen = () => {
    const bearer = $("bearer-token").value.trim();
    ws.send(JSON.stringify(bearer ? { type: "auth", bearer } : { type: "auth", api_key: $("api-key").value.trim() }));
  };

  ws.onmessage = (ev) => {
    if (gen !== app.wsGeneration) return; // 旧世代の残メッセージは無視
    if (ev.data instanceof ArrayBuffer) {
      const batch = decodeAudioOut(ev.data);
      if (batch) {
        app.batchesReceived++;
        for (const p of batch.packets) {
          app.decoder.decode(new EncodedAudioChunk({
            type: "key", timestamp: app.decodeTimestamp, data: p,
          }));
          app.decodeTimestamp += 20000;
        }
      }
      return;
    }
    const msg = JSON.parse(ev.data);
    handleEvent(msg);
  };

  ws.onclose = (ev) => {
    if (gen !== app.wsGeneration) return;
    if (!app.running) { setBadge("終了", "idle"); return; }
    // 予期しない切断 or サーバー主導 close → resumption handle で再接続
    addLine("sys", `切断 (code=${ev.code}) → 再接続します`, "sys");
    scheduleReconnect(500);
  };
  ws.onerror = () => {};
}

function scheduleReconnect(delayMs) {
  if (!app.running) return;
  app.reconnects++;
  $("stat-reconnect").textContent = "🔁 " + app.reconnects;
  setTimeout(() => { if (app.running) connect(); }, delayMs);
}

function handleEvent(msg) {
  switch (msg.type) {
    case "auth_ok":
      showBalance(msg.balance);
      const ctxTrigger = parseInt($("ctx-trigger").value, 10);
      const ctxTarget = parseInt($("ctx-target").value, 10);
      const contextWindow = {};
      if (ctxTrigger > 0) contextWindow.trigger_tokens = ctxTrigger;
      if (ctxTarget > 0) contextWindow.target_tokens = ctxTarget;
      app.ws.send(JSON.stringify({
        type: "start",
        ...(Object.keys(contextWindow).length ? { context_window: contextWindow } : {}),
        ...(app.resumptionHandle ? { resumption_handle: app.resumptionHandle } : {}),
        video_mime_type: "image/jpeg",
      }));
      break;
    case "ready":
      if (msg.context_window) {
        addLine("sys", `記憶窓を適用: trigger=${msg.context_window.trigger_tokens ?? "-"} / target=${msg.context_window.target_tokens ?? "-"}`);
      }
      app.ready = true;
      setBadge("接続中", "connected");
      if (app.reconnects === 0) addLine("sys", "セッション開始（サーバー側プロンプト + get_usage / find_objects 有効）", "sys");
      flushPackets();
      break;
    case "input_transcription": appendTranscript("user", msg.text); break;
    case "output_transcription": appendTranscript("ai", msg.text); break;
    case "interrupted": stopPlaybackNow(); finalizeTurnLines(); break;
    case "turn_complete": finalizeTurnLines(); break;
    case "watch_started": {
      const targets = (msg.targets || []).join("、");
      setWatchStatus(`🔭 見張り中: ${targets}（${msg.interval_s}秒毎・最長${Math.round(msg.timeout_s)}秒）`, false);
      $("watch-hit-img").classList.add("hidden");
      $("watch-hit-detail").classList.add("hidden");
      addLine("sys", `見張り開始: ${targets}`, "sys");
      break;
    }
    case "watch_result": showWatchHit(msg); break;
    case "watch_stopped": {
      const reasonJa = { found: "発見", timeout: "時間切れ", stopped: "停止",
                         replaced: "別の見張りに交代", error: "エラー" }[msg.reason] || msg.reason;
      // found のときは showWatchHit の表示を残す（上書きしない）
      if (msg.reason !== "found") setWatchStatus(`🔭 見張り終了（${reasonJa}）`, false);
      addLine("sys", `見張り終了（${reasonJa}）`, "sys");
      break;
    }
    case "resumption_update": app.resumptionHandle = msg.handle; break;
    case "reconnect_hint":
      addLine("sys", `サーバーから再接続の合図（残り ${Math.round((msg.deadline_ms || 0) / 1000)} 秒）`, "sys");
      // break-before-make: 明示的に閉じて onclose の再接続経路に乗せる
      try { app.ws.close(1000, "planned reconnect"); } catch (e) {}
      break;
    case "go_away": break;
    case "tool_call_started":
      toolBanner.classList.remove("hidden");
      toolBanner.textContent =
        `🔧 ${msg.name} 実行中…（video_seq=${msg.video_seq ?? "-"} / depth_seq=${msg.depth_seq ?? "-"}）`;
      break;
    case "tool_call_result":
      toolBanner.textContent = `🔧 ${msg.name} 完了: ${msg.summary || ""}`;
      setTimeout(() => toolBanner.classList.add("hidden"), 5000);
      break;
    case "tool_call_cancelled":
      toolBanner.classList.add("hidden");
      break;
    case "usage":
      // セッション累計コスト（サーバー側でモダリティ別単価から算出した見積もり）
      if (msg.cost_jpy_total != null) {
        $("stat-cost").textContent = `💴 このセッション: ¥${msg.cost_jpy_total.toFixed(1)}`;
      } else if (msg.cost_usd_total != null) {
        $("stat-cost").textContent = `💴 このセッション: $${msg.cost_usd_total.toFixed(4)}`;
      }
      // Google 検索の実行クエリ数と参考推定額（トークン費と別建て・無料枠 1,500/日 は未考慮）
      if (msg.web_search_count != null) {
        const jpy = msg.search_cost_jpy_estimate != null
          ? `（推定¥${msg.search_cost_jpy_estimate.toFixed(1)}）` : "";
        $("stat-search").textContent = `🔍 検索: ${msg.web_search_count}回${jpy}`;
      }
      break;
    case "balance":
      // DB に利用額を記録した直後の実残高（＝実際に減った後の値）
      showBalance(msg);
      if (msg.session_cost_jpy != null) {
        $("stat-cost").textContent = `💴 このセッション: ¥${msg.session_cost_jpy.toFixed(1)}`;
      }
      break;
    case "error": addLine("sys", `エラー: ${msg.code} ${msg.message || ""}`, "sys"); break;
    case "session_end":
      addLine("sys", `セッション終了 (${msg.reason})`, "sys");
      if (msg.reason === "idle" || msg.reason === "stop") stopAll();
      break;
  }
}

function showBalance(balance) {
  const el = $("stat-balance");
  if (!balance) {
    // DB に紐づかない API キー（env ベース）や DB 未接続では残高が取れない
    el.textContent = "🏦 残高: 不明（DB未登録キー）";
    return;
  }
  const parts = [];
  const fmt = (v) => `¥${Math.round(v).toLocaleString()}`;
  if (balance.total_remaining_jpy != null) parts.push(`累計${fmt(balance.total_remaining_jpy)}`);
  if (balance.monthly_remaining_jpy != null) parts.push(`月${fmt(balance.monthly_remaining_jpy)}`);
  if (balance.daily_remaining_jpy != null) parts.push(`日${fmt(balance.daily_remaining_jpy)}`);
  el.textContent = parts.length ? `🏦 残高: ${parts.join(" / ")}` : "🏦 残高: 予算未設定";
}

// ---------- ライフサイクル ----------
// スマホは放置すると画面が消えてカメラ/マイクも止まるので、セッション中は Wake Lock で防ぐ。
// タブ切替や画面ロックでロックは自動解放されるため、復帰時（visibilitychange）に取り直す。
async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { app.wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (app.running && document.visibilityState === "visible") acquireWakeLock();
});

async function startAll() {
  const warn = await checkSupport();
  if (warn) { $("support-warn").textContent = warn; return; }
  localStorage.setItem("live_v2_api_key", $("api-key").value.trim());
  const depthFile = $("depth-file").files[0];
  app.depthBytes = depthFile ? new Uint8Array(await depthFile.arrayBuffer()) : null;
  $("setup-screen").classList.add("hidden");
  $("session-screen").classList.remove("hidden");
  document.body.classList.add("session-active");
  acquireWakeLock();
  app.running = true;
  app.startedAt = Date.now();
  setupPlayback();
  await startCapture();
  await startCamera();
  connect();
  app.statTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - app.startedAt) / 1000);
    $("stat-time").textContent = String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
    $("stat-frames").textContent = "📷 " + app.framesSent;
    $("stat-audio-in").textContent = "🎙 " + Math.round(app.audioMsSent / 1000) + "s";
    $("stat-audio-out").textContent = "🔊 " + app.batchesReceived;
  }, 1000);
}

function stopAll() {
  app.running = false;
  document.body.classList.remove("session-active");
  try { app.wakeLock && app.wakeLock.release(); } catch (e) {}
  app.wakeLock = null;
  try { app.ws && app.ws.readyState === WebSocket.OPEN && app.ws.send(JSON.stringify({ type: "stop" })); } catch (e) {}
  setTimeout(() => { try { app.ws && app.ws.close(); } catch (e) {} }, 300);
  clearInterval(app.videoTimer); clearInterval(app.statTimer);
  try { app.encoder && app.encoder.close(); } catch (e) {}
  try { app.decoder && app.decoder.close(); } catch (e) {}
  try { app.workletNode && app.workletNode.disconnect(); } catch (e) {}
  app.micStream && app.micStream.getTracks().forEach(t => t.stop());
  app.camStream && app.camStream.getTracks().forEach(t => t.stop());
  try { app.captureCtx && app.captureCtx.close(); } catch (e) {}
  try { app.playbackCtx && app.playbackCtx.close(); } catch (e) {}
  setBadge("終了", "idle");
}

// ---------- 初期化 ----------
window.addEventListener("load", () => {
  $("api-key").value = localStorage.getItem("live_v2_api_key") || "";
  $("start-btn").addEventListener("click", startAll);
  $("stop-btn").addEventListener("click", stopAll);
  $("watch-dismiss").addEventListener("click", () => $("watch-panel").classList.add("hidden"));
  checkSupport().then(w => { if (w) $("support-warn").textContent = w; });
});
