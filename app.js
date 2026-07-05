// Gemini Live API リアルタイム会話テストアプリ
// lives-api-server の /gemini-md 中継に接続し、マイク音声 + カメラ映像(1FPS)を
// ストリーミングして、AIの音声応答をリアルタイム再生する。
// resumption ハンドルによる自動再接続（記憶引き継ぎ）と、
// compression による長時間セッションの挙動確認用。

'use strict';

const $ = (sel) => document.querySelector(sel);

// ---- 設定値 ----
const AUDIO_IN_RATE = 16000;   // Live API 入力: 16kHz PCM16
const AUDIO_OUT_RATE = 24000;  // Live API 出力: 24kHz PCM16
const FRAME_INTERVAL_MS = 1000; // カメラフレーム送信間隔（1FPS）
const FRAME_MAX_SIDE = 640;     // 送信フレームの長辺px（トークン・帯域節約）
const JPEG_QUALITY = 0.7;
const AUDIO_CHUNK_MS = 250;     // 音声送信バッチ間隔
const RECONNECT_DELAY_MS = 1000;
// 料金目安（gemini-live-2.5-flash-native-audio, USDJPY=161）
const YEN_PER_MIN_INPUT = (0.005 + 0.002) * 161; // 音声入力+映像入力 /分
const YEN_PER_MIN_AUDIO_OUT = 0.018 * 161;       // 音声出力 /分

// ---- 状態 ----
const state = {
  ws: null,
  active: false,        // ユーザーがセッションを開始しているか
  setupDone: false,     // setupComplete 受信済みか
  resumptionHandle: null,
  reconnectCount: 0,
  muted: false,
  mediaStream: null,
  audioCtx: null,
  workletNode: null,
  frameTimer: null,
  statTimer: null,
  startedAt: null,
  framesSent: 0,
  audioInSec: 0,
  audioOutSec: 0,
  playQueueTime: 0,     // 次の再生スケジュール時刻
  activeSources: [],    // 再生中の AudioBufferSourceNode（割り込み時に停止）
  wakeLock: null,
  currentAiLine: null,  // 進行中のAI発話の transcript 要素
  currentUserLine: null,
};

// ---- ユーティリティ ----
function log(msg) {
  const el = $('#debug-log');
  const ts = new Date().toTimeString().slice(0, 8);
  el.textContent = `[${ts}] ${msg}\n` + el.textContent.slice(0, 20000);
  console.log(msg);
}

function setBadge(text, cls) {
  const b = $('#conn-badge');
  b.textContent = text;
  b.className = `badge ${cls}`;
}

function addTranscript(who, text) {
  const div = document.createElement('div');
  div.className = `line ${who}`;
  div.textContent = text;
  const t = $('#transcript');
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  return div;
}

function b64ToInt16(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return new Int16Array(buf);
}

function int16ToB64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- マイク取り込み（AudioWorklet, 16kHzへダウンサンプル） ----
const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.bufLen = 0;
    this.targetLen = Math.round(sampleRate * ${AUDIO_CHUNK_MS} / 1000);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.bufLen += ch.length;
      if (this.bufLen >= this.targetLen) {
        const all = new Float32Array(this.bufLen);
        let off = 0;
        for (const b of this.buf) { all.set(b, off); off += b.length; }
        this.port.postMessage({ samples: all, rate: sampleRate });
        this.buf = [];
        this.bufLen = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

function downsampleTo16k(float32, srcRate) {
  if (srcRate === AUDIO_IN_RATE) return float32;
  const ratio = srcRate / AUDIO_IN_RATE;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    out[i] = float32[i0] + (float32[i1] - float32[i0]) * (pos - i0);
  }
  return out;
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

// ---- WebSocket 接続 ----
function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function connect() {
  const url = $('#ws-url').value.trim();
  const apiKey = $('#api-key').value.trim();
  setBadge(state.reconnectCount > 0 ? '再接続中…' : '接続中…', 'connecting');
  state.setupDone = false;

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    log('WS open — 認証送信');
    ws.send(JSON.stringify({ api_key: apiKey }));
    const config = {
      response_modalities: ['AUDIO'],
      system_instruction: $('#system-prompt').value,
    };
    if (state.resumptionHandle) {
      config.resumption_handle = state.resumptionHandle;
      log(`resumption ハンドルで再開: ${state.resumptionHandle.slice(0, 16)}…`);
    }
    ws.send(JSON.stringify({ config }));
  };

  ws.onmessage = (ev) => handleServerMessage(ev.data);

  ws.onclose = (ev) => {
    log(`WS close: code=${ev.code} reason=${ev.reason || '(なし)'}`);
    state.setupDone = false;
    if (state.active) {
      // セッション継続中の切断 → resumption ハンドルで自動再接続
      state.reconnectCount++;
      $('#stat-reconnect').textContent = `🔁 ${state.reconnectCount}`;
      setBadge('再接続待ち…', 'connecting');
      setTimeout(() => { if (state.active) connect(); }, RECONNECT_DELAY_MS);
    } else {
      setBadge('未接続', 'idle');
    }
  };

  ws.onerror = () => log('WS error');
}

function handleServerMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  if (data.setupComplete) {
    state.setupDone = true;
    setBadge('LIVE', 'live');
    log(`setupComplete session=${JSON.stringify(data.setupComplete).slice(0, 60)}`);
    return;
  }

  if (data.sessionResumptionUpdate) {
    const u = data.sessionResumptionUpdate;
    if (u.resumable && u.newHandle) {
      state.resumptionHandle = u.newHandle;
      log(`resumption ハンドル更新: ${u.newHandle.slice(0, 16)}…`);
    }
    return;
  }

  if (data.goAway) {
    // 接続寿命が近い通知。close 後に onclose の自動再接続で引き継ぐ
    log(`goAway 受信（接続寿命）: ${JSON.stringify(data.goAway)}`);
    return;
  }

  const sc = data.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    // ユーザーが話し始めた → AI音声の再生キューを破棄（barge-in）
    log('interrupted — 再生キューを破棄');
    stopPlayback();
    state.currentAiLine = null;
    return;
  }

  // ユーザー発話の文字起こし
  if (sc.inputTranscription && sc.inputTranscription.text) {
    if (!state.currentUserLine) state.currentUserLine = addTranscript('user', '');
    state.currentUserLine.textContent += sc.inputTranscription.text;
  }

  // AI発話の文字起こし
  if (sc.outputTranscription && sc.outputTranscription.text) {
    if (!state.currentAiLine) state.currentAiLine = addTranscript('ai', '');
    state.currentAiLine.textContent += sc.outputTranscription.text;
    state.currentUserLine = null;
  }

  // AI音声（24kHz PCM16 base64）
  const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      playAudioChunk(part.inlineData.data);
    }
  }

  if (sc.turnComplete) {
    state.currentAiLine = null;
    state.currentUserLine = null;
  }
}

// ---- AI音声の再生 ----
function playAudioChunk(b64) {
  const ctx = state.audioCtx;
  if (!ctx) return;
  const int16 = b64ToInt16(b64);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

  const buf = ctx.createBuffer(1, float32.length, AUDIO_OUT_RATE);
  buf.getChannelData(0).set(float32);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  const startAt = Math.max(ctx.currentTime, state.playQueueTime);
  src.start(startAt);
  state.playQueueTime = startAt + buf.duration;
  state.audioOutSec += buf.duration;

  state.activeSources.push(src);
  src.onended = () => {
    state.activeSources = state.activeSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  for (const src of state.activeSources) {
    try { src.stop(); } catch { /* already stopped */ }
  }
  state.activeSources = [];
  state.playQueueTime = 0;
}

// ---- カメラフレーム送信（1FPS） ----
function sendFrame() {
  if (!state.setupDone) return;
  const video = $('#camera-preview');
  if (!video.videoWidth) return;

  const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  const canvas = sendFrame._canvas || (sendFrame._canvas = document.createElement('canvas'));
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (wsSend({ realtime_input: { media_chunks: [{ mime_type: 'image/jpeg', data: b64 }] } })) {
    state.framesSent++;
  }
}

// ---- セッション制御 ----
async function startSession() {
  const apiKey = $('#api-key').value.trim();
  if (!apiKey) { alert('APIキーを入力してください'); return; }
  localStorage.setItem('liveapi_key', apiKey);
  localStorage.setItem('liveapi_url', $('#ws-url').value.trim());

  // カメラ+マイク取得（背面カメラ優先）
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { facingMode: 'environment', width: { ideal: 1280 } },
    });
  } catch (e) {
    alert(`カメラ/マイクを取得できません: ${e.message}`);
    return;
  }
  $('#camera-preview').srcObject = state.mediaStream;

  // AudioContext はユーザー操作起点で作る（iOS Safari 制約）
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await state.audioCtx.resume();

  // マイク → AudioWorklet → 16kHz PCM16 → WS
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
  await state.audioCtx.audioWorklet.addModule(blobUrl);
  const micSource = state.audioCtx.createMediaStreamSource(state.mediaStream);
  state.workletNode = new AudioWorkletNode(state.audioCtx, 'capture-processor');
  state.workletNode.port.onmessage = (ev) => {
    if (!state.setupDone || state.muted) return;
    const down = downsampleTo16k(ev.data.samples, ev.data.rate);
    const int16 = floatToInt16(down);
    if (wsSend({ realtime_input: { media_chunks: [{ mime_type: 'audio/pcm', data: int16ToB64(int16) }] } })) {
      state.audioInSec += down.length / AUDIO_IN_RATE;
    }
  };
  micSource.connect(state.workletNode);
  // worklet は出力しないが、グラフを生かすため無音で destination に繋ぐ
  const silent = state.audioCtx.createGain();
  silent.gain.value = 0;
  state.workletNode.connect(silent).connect(state.audioCtx.destination);

  // 画面スリープ防止（対応端末のみ）
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 非対応でも続行 */ }

  // 状態初期化して接続
  state.active = true;
  state.resumptionHandle = null;
  state.reconnectCount = 0;
  state.framesSent = 0;
  state.audioInSec = 0;
  state.audioOutSec = 0;
  state.startedAt = Date.now();
  $('#transcript').innerHTML = '';
  $('#stat-reconnect').textContent = '🔁 0';

  connect();
  state.frameTimer = setInterval(sendFrame, FRAME_INTERVAL_MS);
  state.statTimer = setInterval(updateStats, 1000);

  $('#setup-screen').classList.add('hidden');
  $('#session-screen').classList.remove('hidden');
}

function stopSession() {
  state.active = false;
  clearInterval(state.frameTimer);
  clearInterval(state.statTimer);
  stopPlayback();
  if (state.ws) { try { state.ws.close(); } catch { /* noop */ } }
  if (state.workletNode) state.workletNode.disconnect();
  if (state.audioCtx) state.audioCtx.close();
  if (state.mediaStream) state.mediaStream.getTracks().forEach((t) => t.stop());
  if (state.wakeLock) { state.wakeLock.release(); state.wakeLock = null; }
  state.audioCtx = null;
  setBadge('未接続', 'idle');
  $('#setup-screen').classList.remove('hidden');
  $('#session-screen').classList.add('hidden');
  log(`セッション終了: ${Math.round((Date.now() - state.startedAt) / 1000)}s, frames=${state.framesSent}`);
}

function updateStats() {
  const sec = Math.round((Date.now() - state.startedAt) / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  $('#stat-time').textContent = `${mm}:${ss}`;
  $('#stat-frames').textContent = `📷 ${state.framesSent}`;
  $('#stat-audio-in').textContent = `🎙 ${Math.round(state.audioInSec)}s`;
  $('#stat-audio-out').textContent = `🔊 ${Math.round(state.audioOutSec)}s`;
  const yen = (sec / 60) * YEN_PER_MIN_INPUT + (state.audioOutSec / 60) * YEN_PER_MIN_AUDIO_OUT;
  $('#stat-cost').textContent = `≈${yen.toFixed(1)}円`;
}

// ---- 初期化 ----
window.addEventListener('DOMContentLoaded', () => {
  const savedKey = localStorage.getItem('liveapi_key');
  const savedUrl = localStorage.getItem('liveapi_url');
  if (savedKey) $('#api-key').value = savedKey;
  if (savedUrl) $('#ws-url').value = savedUrl;

  $('#start-btn').addEventListener('click', startSession);
  $('#stop-btn').addEventListener('click', stopSession);
  $('#mute-btn').addEventListener('click', () => {
    state.muted = !state.muted;
    $('#mute-btn').textContent = state.muted ? '🔇 ミュート中' : '🎙 ミュート';
    $('#mute-btn').classList.toggle('muted', state.muted);
  });
});
