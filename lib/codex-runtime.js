import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function nativeCodexCandidates(homeDir = os.homedir()) {
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const npmRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex');
  return [
    process.env.CODEX_EXECUTABLE,
    path.join(npmRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(npmRoot, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  ].filter(Boolean);
}

export function resolveCodexExecutable({ homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  if (process.platform === 'win32') {
    const native = nativeCodexCandidates(homeDir).find((candidate) => exists(candidate));
    if (native) return native;
  }
  return 'codex';
}

function codexError(message, code = 'CODEX_ERROR', details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export class CodexRuntime extends EventEmitter {
  constructor({
    executable = resolveCodexExecutable(),
    spawnFn = spawn,
    homeDir = os.homedir(),
    cwd = os.tmpdir(),
    requestTimeoutMs = 30_000,
  } = {}) {
    super();
    Object.assign(this, { executable, spawnFn, homeDir, cwd, requestTimeoutMs });
    this.proc = null;
    this.reader = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.starting = null;
    this.stderr = '';
  }

  async start() {
    if (this.proc && !this.proc.killed) return this;
    if (this.starting) return this.starting;
    this.starting = this._startProcess().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _startProcess() {
    const env = {
      ...process.env,
      HOME: this.homeDir,
      USERPROFILE: process.env.USERPROFILE || this.homeDir,
      CODEX_HOME: process.env.CODEX_HOME || path.join(this.homeDir, '.codex'),
    };
    this.proc = this.spawnFn(this.executable, ['app-server', '--stdio'], {
      cwd: this.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.once('error', (error) => this.#failAll(codexError(`Não foi possível iniciar o Codex: ${error.message}`, 'CODEX_NOT_INSTALLED')));
    this.proc.once('exit', (code, signal) => {
      const detail = this.stderr.trim().slice(-2_000);
      this.#failAll(codexError(`Codex encerrado inesperadamente (${signal || (code ?? 'sem código')}).${detail ? ` ${detail}` : ''}`, 'CODEX_EXITED'));
      this.proc = null;
      this.emit('state', { status: 'stopped', code, signal });
    });
    this.proc.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
      this.emit('diagnostic', { event: 'codex-stderr', message: String(chunk).trim().slice(0, 1_000) });
    });
    this.reader = readline.createInterface({ input: this.proc.stdout });
    this.reader.on('line', (line) => this.#receive(line));
    await this.request('initialize', {
      clientInfo: { name: 'meeting_agent', title: 'Meeting Agent', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    }, this.requestTimeoutMs);
    this.notify('initialized', {});
    this.emit('state', { status: 'ready' });
    return this;
  }

  #write(message) {
    if (!this.proc?.stdin?.writable) throw codexError('Codex local não está disponível.', 'CODEX_OFFLINE');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codexError(`Tempo esgotado em ${method}.`, 'CODEX_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#write({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.#write({ method, params }); }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit('diagnostic', { event: 'codex-invalid-json', message: String(line).slice(0, 1_000) }); return; }
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(codexError(message.error.message || `Falha em ${pending.method}`, 'CODEX_RPC_ERROR', message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      // Meeting Agent nunca autoriza ferramentas, escrita ou pedidos interativos.
      this.#write({ id: message.id, result: { decision: 'decline', action: 'decline', content: null } });
      return;
    }
    this.#notification(message.method, message.params || {});
  }

  #notification(method, params) {
    this.emit('notification', { method, params });
    if (method === 'account/updated' || method === 'account/login/completed' || method === 'account/rateLimits/updated') {
      this.emit('account', { method, ...params });
    }
    const turnId = params.turnId || params.turn?.id;
    const collector = turnId ? this.turns.get(turnId) : null;
    if (!collector) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') collector.text = params.item.text || collector.text;
    if (method === 'item/agentMessage/delta') collector.delta += params.delta || '';
    if (method === 'thread/tokenUsage/updated') collector.usage = params.tokenUsage || params.usage || collector.usage;
    if (method === 'turn/completed') {
      clearTimeout(collector.timer);
      this.turns.delete(turnId);
      const status = params.turn?.status;
      if (status === 'completed') collector.resolve({ text: collector.text || collector.delta, usage: collector.usage, turn: params.turn });
      else collector.reject(codexError(params.turn?.error?.message || `Turno ${status || 'falhou'}.`, status === 'interrupted' ? 'CODEX_TIMEOUT' : 'CODEX_TURN_FAILED', params.turn?.error));
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const turn of this.turns.values()) { clearTimeout(turn.timer); turn.reject(error); }
    this.turns.clear();
  }

  async getAccount({ refreshToken = false } = {}) {
    await this.start();
    return this.request('account/read', { refreshToken });
  }

  async beginLogin() {
    await this.start();
    return this.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' }, 60_000);
  }

  async logout() { await this.start(); return this.request('account/logout', {}); }
  async getRateLimits() { await this.start(); return this.request('account/rateLimits/read', {}); }

  async listModels() {
    await this.start();
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...(result?.data || []));
      cursor = result?.nextCursor || null;
    } while (cursor);
    return models.filter((model) => !model.hidden && (model.inputModalities || ['text']).includes('text'));
  }

  async run(prompt, { model = null, effort = null, schema = null, timeoutMs = 60_000, purpose = 'analysis' } = {}) {
    await this.start();
    const account = await this.getAccount();
    if (account?.account?.type !== 'chatgpt') throw codexError('Entre com o ChatGPT para usar a análise.', 'CODEX_AUTH_REQUIRED');
    const threadResult = await this.request('thread/start', {
      ...(model ? { model } : {}),
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      environments: [],
      serviceName: 'meeting_agent',
      baseInstructions: 'Você é um analisador de reuniões. Não use ferramentas, não acesse arquivos e não execute comandos. Responda somente com a saída solicitada.',
    }, Math.min(timeoutMs, 30_000));
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw codexError('O Codex não criou a sessão de análise.', 'CODEX_THREAD_FAILED');
    const turnResult = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(schema ? { outputSchema: schema } : {}),
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      responsesapiClientMetadata: { purpose },
    }, Math.min(timeoutMs, 30_000));
    const turnId = turnResult?.turn?.id;
    if (!turnId) throw codexError('O Codex não iniciou a análise.', 'CODEX_TURN_FAILED');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(turnId);
        this.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
        reject(codexError(`Tempo esgotado na análise ${purpose}.`, 'CODEX_TIMEOUT'));
      }, timeoutMs);
      this.turns.set(turnId, { resolve, reject, timer, text: '', delta: '', usage: null, threadId });
    });
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.reader?.close();
    this.reader = null;
    this.#failAll(codexError('Codex encerrado.', 'CODEX_STOPPED'));
    proc.kill();
  }
}
