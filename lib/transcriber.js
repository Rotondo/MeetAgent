import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import config from './config.js';

function buildUrl({ model, language, sampleRate }) {
  const params = new URLSearchParams({
    model,
    language,
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    smart_format: 'true',
    interim_results: 'false',
    punctuate: 'true',
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export class Transcriber extends EventEmitter {
  constructor({
    apiKey,
    model = config.deepgramModel,
    language = config.deepgramLanguage,
    sampleRate = config.deepgramSampleRate,
    windowMs = config.analysisWindowMs,
    connectTimeoutMs = config.deepgramConnectTimeoutMs,
    keepAliveMs = config.deepgramKeepAliveMs,
    finalizeWaitMs = config.deepgramFinalizeWaitMs,
    reconnectDelays = [1_000, 2_000, 5_000, 10_000, 30_000],
    WebSocketImpl = WebSocket,
  }) {
    super();
    this.apiKey = apiKey;
    this.url = buildUrl({ model, language, sampleRate });
    this.windowMs = windowMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.keepAliveMs = keepAliveMs;
    this.finalizeWaitMs = finalizeWaitMs;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectDelays = reconnectDelays;
    this.connection = null;
    this.buffer = [];
    this.flushTimer = null;
    this.keepAliveTimer = null;
    this.lastAudioAt = 0;
    this.stopping = false;
    this.started = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  async start() {
    if (this.connection) return;
    this.stopping = false;
    await this._openConnection();
    this.started = true;
    this.flushTimer = setInterval(() => this.flush(), this.windowMs);
    this.keepAliveTimer = setInterval(() => this._sendKeepAlive(), this.keepAliveMs);
  }

  async _openConnection() {
    await new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      this.connection = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate?.();
        reject(new Error('timeout ao conectar à Deepgram'));
      }, this.connectTimeoutMs);

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.reconnectAttempt = 0;
        this.emit('connection-state', { connected: true });
        this.emit('status', 'Deepgram conectada — aguardando áudio.');
        resolve();
      });
      ws.on('message', (raw) => this._handleMessage(raw));
      ws.on('error', (err) => {
        this.emit('transcriber-error', err);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (this.connection === ws) this.connection = null;
        this.emit('connection-state', { connected: false });
        if (!settled) {
          settled = true;
          reject(new Error('conexão encerrada antes de ficar pronta'));
        } else if (!this.stopping && this.started) {
          this.emit('transcriber-error', new Error('conexão com a Deepgram encerrada'));
          this._scheduleReconnect();
        }
      });
    });
  }

  _scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index];
    this.reconnectAttempt += 1;
    this.emit('status', `Deepgram desconectada — reconectando em ${Math.ceil(delay / 1000)}s.`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this._openConnection();
      } catch (err) {
        this.emit('transcriber-error', err);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (data.type !== 'Results' || !data.is_final) return;
    const alternative = data.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;
    const wordTimings = alternative?.words ?? [];
    const timedDuration = wordTimings.length > 1
      ? Number(wordTimings.at(-1)?.end) - Number(wordTimings[0]?.start)
      : 0;
    this.buffer.push(text);
    this.emit('transcript-final', {
      text,
      receivedAt: Date.now(),
      startedAt: Number(data.start) || null,
      duration: timedDuration > 0 ? timedDuration : Number(data.duration) || 0,
    });
  }

  feedAudio(chunk) {
    const ws = this.connection;
    const openState = this.WebSocketImpl.OPEN ?? 1;
    if (!ws || ws.readyState !== openState) return false;
    const data = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
    try {
      ws.send(data);
      this.lastAudioAt = Date.now();
      return true;
    } catch (err) {
      this.emit('transcriber-error', err);
      return false;
    }
  }

  _sendKeepAlive() {
    const ws = this.connection;
    const openState = this.WebSocketImpl.OPEN ?? 1;
    if (!ws || ws.readyState !== openState) return false;
    if (this.lastAudioAt && Date.now() - this.lastAudioAt < this.keepAliveMs) return false;
    try {
      ws.send(JSON.stringify({ type: 'KeepAlive' }));
      return true;
    } catch (err) {
      this.emit('transcriber-error', err);
      return false;
    }
  }

  flush() {
    if (!this.buffer.length) return null;
    const text = this.buffer.join(' ');
    this.buffer = [];
    const chunk = { text, endedAt: Date.now() };
    this.emit('transcript-chunk', chunk);
    return chunk;
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    const ws = this.connection;
    if (ws) {
      const openState = this.WebSocketImpl.OPEN ?? 1;
      if (ws.readyState === openState) {
        ws.send(JSON.stringify({ type: 'Finalize' }));
        await new Promise((resolve) => setTimeout(resolve, this.finalizeWaitMs));
      }
    }
    this.flush();
    ws?.close?.();
    this.connection = null;
  }
}

export { buildUrl };
