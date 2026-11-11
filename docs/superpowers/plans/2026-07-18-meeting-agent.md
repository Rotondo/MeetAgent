# Meeting Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agente local que escuta reuniões (via transcript do Meetily), propõe/executa skills do Claude Code com aprovação de 1 toque num overlay transparente, e executa fila silenciosa + registro CRM automaticamente ao encerrar.

**Architecture:** Um único app Electron. O main process (Node) hospeda Watcher (polling no SQLite do Meetily via sql.js/WASM), Dispatcher (`claude -p` headless), Executor e Output Generator. O renderer é o overlay transparente always-on-top com dois modos (Reunião/Config). Comunicação via IPC do Electron.

**Tech Stack:** Electron (ESM), sql.js (leitura SQLite sem build nativo), node:test (testes), claude CLI (já instalado), vanilla JS no renderer.

## Global Constraints

- Plataforma: Windows 11; caminho do projeto: `C:\caminho\para\meeting-agent`
- 100% local — nenhum áudio/transcript sai da máquina; cérebro via `claude -p` (assinatura existente)
- Toda copy visível ao usuário em português (com acentos corretos)
- Janela do dispatcher: 30s; polling do watcher: 20s; timeout dispatcher: 10s; timeout executor/encerramento: 120s
- Dispatcher usa `--model haiku` (velocidade); executor e encerramento usam modelo padrão
- Prompts do Dispatcher e do Encerramento: copiar VERBATIM do spec (`docs/superpowers/specs/2026-07-18-meeting-agent-design.md`)
- ESM em todo o projeto (`"type": "module"`); Node 20+; Electron 33+
- Aprovação de urgência "alta" é 1 toque (Enter aprova / Esc descarta), uma proposta por vez
- Urgência "baixa" → fila silenciosa, executada automaticamente no encerramento sem confirmação
- Recusar ação N cancela apenas dependentes (`depende_de` transitivo); independentes continuam
- `{{output_N}}` no argumento é substituído pelo resultado real da ação N antes da execução

---

## Estrutura de Arquivos (mapa completo)

```
meeting-agent/
├── package.json              # ESM, scripts: start, test, simulate
├── .gitignore                # node_modules, outputs/, *.log, dados locais
├── start.js                  # atalho: spawna `electron . --project <nome>`
├── lib/
│   ├── config.js             # constantes (timeouts, caminhos padrão, cmd do claude)
│   ├── projects.js           # CRUD de projects.json + settings (meetilyDbPath)
│   ├── skills.js             # scan de skills de um projeto → cardápio
│   ├── claude-client.js      # runClaude(prompt, opts) + parseJsonLoose(text)
│   ├── watcher.js            # polling no SQLite do Meetily, emite transcript-chunk
│   ├── dispatcher.js         # análise 30s, roteia urgências, cadeias, resumo
│   ├── executor.js           # executa skill via claude -p no cwd do projeto
│   └── output-generator.js   # encerramento: relatório + executar_agora
├── overlay/
│   ├── main.js               # Electron main: janela + IPC + orquestração
│   ├── preload.js            # contextBridge
│   └── renderer/
│       ├── index.html
│       ├── app.js            # modos Reunião/Config, beep via Web Audio
│       └── style.css
├── scripts/
│   └── simulate.js           # gera SQLite fake e insere falas ao longo do tempo
├── test/
│   ├── projects.test.js
│   ├── skills.test.js
│   ├── claude-client.test.js
│   ├── watcher.test.js
│   ├── dispatcher.test.js
│   ├── executor.test.js
│   └── output-generator.test.js
└── docs/superpowers/…        # spec e este plano
```

---

### Task 1: Scaffold do projeto

**Files:**
- Create: `package.json`, `.gitignore`, `lib/config.js`

**Interfaces:**
- Produces: `config` default export com `{ dispatcherTimeoutMs: 10000, executorTimeoutMs: 120000, pollMs: 20000, windowMs: 30000, claudeCmd: 'claude', dispatcherModel: 'haiku', dataDir, projectsFile, outputsDir }`

- [ ] **Step 1: Inicializar git e npm**

```bash
cd "C:\caminho\para\meeting-agent"
git init
npm init -y
npm install --save-dev electron
npm install sql.js
```

- [ ] **Step 2: Escrever package.json final**

```json
{
  "name": "meeting-agent",
  "version": "0.1.0",
  "type": "module",
  "main": "overlay/main.js",
  "scripts": {
    "start": "electron . ",
    "test": "node --test test/",
    "simulate": "node scripts/simulate.js"
  },
  "dependencies": {
    "sql.js": "^1.11.0"
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```
(Manter as versões que o npm instalar; o bloco acima define nome/scripts/type.)

- [ ] **Step 3: Escrever .gitignore**

```
node_modules/
outputs/
*.log
.env
```

- [ ] **Step 4: Escrever lib/config.js**

```js
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.homedir(), 'meeting-agent');

export default {
  dispatcherTimeoutMs: 10_000,
  executorTimeoutMs: 120_000,
  pollMs: 20_000,
  windowMs: 30_000,
  claudeCmd: 'claude',
  dispatcherModel: 'haiku',
  dataDir,
  projectsFile: path.join(dataDir, 'projects.json'),
  outputsDir: path.join(dataDir, 'outputs'),
};
```

- [ ] **Step 5: Verificar que o test runner roda vazio e commitar**

Run: `node --test test/ ; echo done` (aceitar "no test files" — criar pasta `test/` vazia com `.gitkeep`)

```bash
git add -A
git commit -m "chore: scaffold meeting-agent (electron + sql.js + config)"
```

---

### Task 2: Store de projetos e settings (`lib/projects.js`)

**Files:**
- Create: `lib/projects.js`
- Test: `test/projects.test.js`

**Interfaces:**
- Consumes: `config.projectsFile` (Task 1)
- Produces:
  - `loadStore(filePath?) → { settings: { meetilyDbPath: string|null }, projects: Project[] }`
  - `saveStore(store, filePath?)`
  - `upsertProject(store, { name, path, skills }) → store` (name é a chave; skills = string[] de nomes habilitados)
  - `deleteProject(store, name) → store`
  - `getProject(store, name) → Project|null`
  - Arquivo inexistente → store vazio válido `{ settings: { meetilyDbPath: null }, projects: [] }`

- [ ] **Step 1: Escrever teste que falha**

```js
// test/projects.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStore, saveStore, upsertProject, deleteProject, getProject } from '../lib/projects.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-')), 'projects.json');
}

test('loadStore retorna store vazio quando arquivo não existe', () => {
  const store = loadStore(tmpFile());
  assert.deepEqual(store, { settings: { meetilyDbPath: null }, projects: [] });
});

test('upsert + save + load roundtrip', () => {
  const file = tmpFile();
  let store = loadStore(file);
  store = upsertProject(store, { name: 'prm', path: 'C:/x/PRM', skills: ['a', 'b'] });
  saveStore(store, file);
  const loaded = loadStore(file);
  assert.equal(getProject(loaded, 'prm').path, 'C:/x/PRM');
  assert.deepEqual(getProject(loaded, 'prm').skills, ['a', 'b']);
});

test('upsert substitui projeto de mesmo nome e delete remove', () => {
  let store = loadStore(tmpFile());
  store = upsertProject(store, { name: 'prm', path: 'C:/a', skills: [] });
  store = upsertProject(store, { name: 'prm', path: 'C:/b', skills: [] });
  assert.equal(store.projects.length, 1);
  assert.equal(getProject(store, 'prm').path, 'C:/b');
  store = deleteProject(store, 'prm');
  assert.equal(getProject(store, 'prm'), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/projects.test.js`
Expected: FAIL (módulo `../lib/projects.js` não existe)

- [ ] **Step 3: Implementar lib/projects.js**

```js
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const EMPTY = () => ({ settings: { meetilyDbPath: null }, projects: [] });

export function loadStore(filePath = config.projectsFile) {
  if (!fs.existsSync(filePath)) return EMPTY();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      settings: { meetilyDbPath: raw?.settings?.meetilyDbPath ?? null },
      projects: Array.isArray(raw?.projects) ? raw.projects : [],
    };
  } catch {
    return EMPTY();
  }
}

export function saveStore(store, filePath = config.projectsFile) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

export function upsertProject(store, project) {
  const projects = store.projects.filter((p) => p.name !== project.name);
  projects.push({ name: project.name, path: project.path, skills: project.skills ?? [] });
  return { ...store, projects };
}

export function deleteProject(store, name) {
  return { ...store, projects: store.projects.filter((p) => p.name !== name) };
}

export function getProject(store, name) {
  return store.projects.find((p) => p.name === name) ?? null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/projects.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/projects.js test/projects.test.js
git commit -m "feat: store de projetos e settings com roundtrip em JSON"
```

---

### Task 3: Descoberta de skills (`lib/skills.js`)

**Files:**
- Create: `lib/skills.js`
- Test: `test/skills.test.js`

**Interfaces:**
- Produces:
  - `scanSkills(projectPath) → [{ name, description }]` — lê `<projectPath>/.claude/skills/*/SKILL.md`, extrai `name:` e `description:` do frontmatter YAML (parse por regex, sem lib)
  - `buildCardapio(skills, enabledNames|null) → string` — uma linha por skill: `- <name>: <description>`; se `enabledNames` for array, filtra por ele

- [ ] **Step 1: Escrever teste que falha**

```js
// test/skills.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSkills, buildCardapio } from '../lib/skills.js';

function makeProject(skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-skills-'));
  for (const [name, description] of skills) {
    const dir = path.join(root, '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\ncorpo`,
    );
  }
  return root;
}

test('scanSkills lê name/description do frontmatter', () => {
  const root = makeProject([['atualiza-crm', 'Atualiza o CRM'], ['busca-dado', 'Busca dado no banco']]);
  const found = scanSkills(root).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(found, [
    { name: 'atualiza-crm', description: 'Atualiza o CRM' },
    { name: 'busca-dado', description: 'Busca dado no banco' },
  ]);
});

test('scanSkills retorna [] quando não há pasta de skills', () => {
  assert.deepEqual(scanSkills(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-empty-'))), []);
});

test('buildCardapio formata e filtra por habilitadas', () => {
  const skills = [{ name: 'a', description: 'faz A' }, { name: 'b', description: 'faz B' }];
  assert.equal(buildCardapio(skills, null), '- a: faz A\n- b: faz B');
  assert.equal(buildCardapio(skills, ['b']), '- b: faz B');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/skills.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/skills.js**

```js
import fs from 'node:fs';
import path from 'node:path';

export function scanSkills(projectPath) {
  const skillsDir = path.join(projectPath, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name;
    const description = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    result.push({ name, description });
  }
  return result;
}

export function buildCardapio(skills, enabledNames = null) {
  const filtered = enabledNames ? skills.filter((s) => enabledNames.includes(s.name)) : skills;
  return filtered.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/skills.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/skills.js test/skills.test.js
git commit -m "feat: descoberta de skills e cardápio para o dispatcher"
```

---

### Task 4: Cliente Claude (`lib/claude-client.js`)

**Files:**
- Create: `lib/claude-client.js`
- Test: `test/claude-client.test.js`

**Interfaces:**
- Produces:
  - `runClaude(prompt, { cwd, timeoutMs, model, cmd, extraArgs }) → Promise<string>` — spawna `<cmd> -p [--model <model>] <extraArgs...>`, escreve o prompt no stdin, resolve com stdout; rejeita com `Error('timeout')` no timeout (mata o processo) e `Error('exit <code>: <stderr>')` em falha
  - `parseJsonLoose(text) → object|null` — remove cercas de código, encontra o primeiro `{` e o último `}`, tenta `JSON.parse`; retorna `null` em falha (nunca lança)
- Consumido por: dispatcher (Task 6), executor (Task 7), output-generator (Task 8) — todos recebem `runClaude` injetado para testabilidade

- [ ] **Step 1: Escrever teste que falha**

```js
// test/claude-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaude, parseJsonLoose } from '../lib/claude-client.js';

test('parseJsonLoose extrai JSON de texto com cercas e ruído', () => {
  assert.deepEqual(parseJsonLoose('claro!\n```json\n{"a": 1}\n```\nfim'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"acoes": [], "alerta": null}'), { acoes: [], alerta: null });
  assert.equal(parseJsonLoose('nada de json aqui'), null);
  assert.equal(parseJsonLoose('{quebrado'), null);
});

test('runClaude envia prompt via stdin e captura stdout (cmd fake)', async () => {
  // usa node como executável fake que ecoa o stdin em maiúsculas
  const out = await runClaude('ola mundo', {
    cmd: process.execPath,
    extraArgs: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d.toString().toUpperCase()))'],
    rawArgs: true,
    timeoutMs: 10_000,
  });
  assert.match(out, /OLA MUNDO/);
});

test('runClaude rejeita em timeout', async () => {
  await assert.rejects(
    runClaude('x', {
      cmd: process.execPath,
      extraArgs: ['-e', 'setTimeout(()=>{}, 60000)'],
      rawArgs: true,
      timeoutMs: 300,
    }),
    /timeout/,
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/claude-client.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/claude-client.js**

```js
import { spawn } from 'node:child_process';
import config from './config.js';

// rawArgs=true: usa apenas cmd+extraArgs (testes). rawArgs=false: monta CLI real do claude.
export function runClaude(prompt, opts = {}) {
  const {
    cwd, timeoutMs = config.executorTimeoutMs, model, cmd = config.claudeCmd,
    extraArgs = [], rawArgs = false,
  } = opts;
  const args = rawArgs ? extraArgs : ['-p', ...(model ? ['--model', model] : []), ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: !rawArgs, windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/claude-client.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/claude-client.js test/claude-client.test.js
git commit -m "feat: cliente claude -p com timeout e parser JSON tolerante"
```

---

### Task 5: Watcher do SQLite do Meetily (`lib/watcher.js`)

**Files:**
- Create: `lib/watcher.js`
- Test: `test/watcher.test.js`

**Interfaces:**
- Consumes: `sql.js` (initSqlJs), `config.pollMs`/`config.windowMs`
- Produces: classe `Watcher extends EventEmitter`
  - `new Watcher({ dbPath, pollMs, windowMs })`
  - `await w.start()` — inicia polling; `w.stop()`
  - `await w.pollOnce()` — exposto para testes: lê o arquivo, detecta linhas novas, acumula buffer; emite `'transcript-chunk'` com `{ text, startedAt, endedAt }` quando há buffer e `windowMs` decorreu desde a última emissão (na primeira leitura emite imediatamente)
  - Emite `'watcher-error'` com `Error` quando o arquivo não existe/não abre (não lança)
  - `discoverTranscriptSource(db) → { table, idCol, textCol }|null` — exportada; procura tabela cujo nome case com `/transcript|segment|sentence/i` e coluna de texto entre `text|content|transcription|transcript`; `idCol` = coluna `id` ou primeira INTEGER PK
- O SQLite inteiro é recarregado do disco a cada poll (sql.js é in-memory; DBs de reunião são pequenos)

- [ ] **Step 1: Escrever teste que falha**

```js
// test/watcher.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import initSqlJs from 'sql.js';
import { Watcher, discoverTranscriptSource } from '../lib/watcher.js';

async function makeDb(rows) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE transcript_segments (id INTEGER PRIMARY KEY, text TEXT, created_at TEXT)');
  for (const r of rows) db.run('INSERT INTO transcript_segments (text, created_at) VALUES (?, ?)', [r, '2026-07-18']);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-db-')), 'meetily.db');
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return { file, SQL };
}

test('discoverTranscriptSource encontra tabela e colunas', async () => {
  const { file, SQL } = await makeDb(['ola']);
  const db = new SQL.Database(fs.readFileSync(file));
  const src = discoverTranscriptSource(db);
  assert.deepEqual(src, { table: 'transcript_segments', idCol: 'id', textCol: 'text' });
  db.close();
});

test('pollOnce emite apenas linhas novas entre polls', async () => {
  const { file, SQL } = await makeDb(['primeira fala', 'segunda fala']);
  const w = new Watcher({ dbPath: file, pollMs: 999999, windowMs: 0 });
  const chunks = [];
  w.on('transcript-chunk', (c) => chunks.push(c.text));
  await w.pollOnce();
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /primeira fala[\s\S]*segunda fala/);

  // adiciona uma linha nova ao arquivo
  const db = new SQL.Database(fs.readFileSync(file));
  db.run("INSERT INTO transcript_segments (text, created_at) VALUES ('terceira fala', 'x')");
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();

  await w.pollOnce();
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /terceira fala/);
  assert.doesNotMatch(chunks[1], /primeira fala/);
});

test('emite watcher-error quando arquivo não existe', async () => {
  const w = new Watcher({ dbPath: 'C:/nao/existe.db', pollMs: 999999, windowMs: 0 });
  const errors = [];
  w.on('watcher-error', (e) => errors.push(e));
  await w.pollOnce();
  assert.equal(errors.length, 1);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/watcher.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/watcher.js**

```js
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import initSqlJs from 'sql.js';
import config from './config.js';

const TEXT_COLS = ['text', 'content', 'transcription', 'transcript'];

export function discoverTranscriptSource(db) {
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() ?? [];
  const candidates = tables.filter((t) => /transcript|segment|sentence/i.test(t));
  for (const table of candidates.length ? candidates : tables) {
    const cols = db.exec(`PRAGMA table_info(${JSON.stringify(table)})`)[0]?.values ?? [];
    const names = cols.map((c) => String(c[1]));
    const textCol = TEXT_COLS.find((t) => names.includes(t));
    if (!textCol) continue;
    const idCol = names.includes('id') ? 'id' : String(cols.find((c) => c[5] === 1)?.[1] ?? 'rowid');
    return { table, idCol, textCol };
  }
  return null;
}

export class Watcher extends EventEmitter {
  constructor({ dbPath, pollMs = config.pollMs, windowMs = config.windowMs }) {
    super();
    this.dbPath = dbPath;
    this.pollMs = pollMs;
    this.windowMs = windowMs;
    this.lastId = 0;
    this.buffer = [];
    this.lastEmit = 0;
    this.timer = null;
    this.SQL = null;
  }

  async start() {
    this.SQL = await initSqlJs();
    await this.pollOnce();
    this.timer = setInterval(() => this.pollOnce().catch(() => {}), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce() {
    if (!this.SQL) this.SQL = await initSqlJs();
    let db;
    try {
      db = new this.SQL.Database(fs.readFileSync(this.dbPath));
    } catch (err) {
      this.emit('watcher-error', err);
      return;
    }
    try {
      const src = discoverTranscriptSource(db);
      if (!src) {
        this.emit('watcher-error', new Error('nenhuma tabela de transcript encontrada'));
        return;
      }
      const res = db.exec(
        `SELECT ${src.idCol}, ${src.textCol} FROM ${JSON.stringify(src.table)} WHERE ${src.idCol} > ${this.lastId} ORDER BY ${src.idCol}`,
      )[0];
      for (const [id, text] of res?.values ?? []) {
        this.lastId = Math.max(this.lastId, Number(id));
        if (text) this.buffer.push(String(text));
      }
      const now = Date.now();
      if (this.buffer.length && now - this.lastEmit >= this.windowMs) {
        const chunk = { text: this.buffer.join('\n'), startedAt: this.lastEmit || now, endedAt: now };
        this.buffer = [];
        this.lastEmit = now;
        this.emit('transcript-chunk', chunk);
      }
    } finally {
      db.close();
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/watcher.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/watcher.js test/watcher.test.js
git commit -m "feat: watcher do SQLite do Meetily com descoberta de schema"
```

---

### Task 6: Dispatcher (`lib/dispatcher.js`)

**Files:**
- Create: `lib/dispatcher.js`
- Test: `test/dispatcher.test.js`

**Interfaces:**
- Consumes: `runClaude`-like injetado (`runFn(prompt, opts) → Promise<string>`), `parseJsonLoose` (Task 4)
- Produces: classe `Dispatcher extends EventEmitter`
  - `new Dispatcher({ runFn, skillsCardapio, model, timeoutMs })`
  - `await d.handleChunk(chunkText)` — monta o prompt (VERBATIM do spec), chama `runFn`, parseia; atualiza `d.meetingSummary`; roteia:
    - ações `urgencia:"alta"` → entram em `d.pendingQueue`; emite `'suggestion'` com a primeira se nenhuma pendente: `{ id, ordem, proposta, skill, argumento, urgencia, depende_de }`
    - ações `urgencia:"baixa"` → push em `d.filaSilenciosa`
    - `alerta` não-nulo → emite `'suggestion'` `{ id, proposta: alerta, skill: null, argumento: null, urgencia: 'alerta' }`
  - `d.resolveDecision(id, approved) → action|null` — se aprovado, retorna a ação com `argumento` já resolvido via `resolveArgument`; se recusado, cancela dependentes transitivos na fila e retorna `null`; em ambos os casos emite a próxima `'suggestion'` da fila se houver
  - `d.recordResult(id, output)` — guarda output para `{{output_N}}` (mapa por `ordem` dentro do lote) e adiciona a `d.executedActions`
  - `d.resolveArgument(arg) → string` — substitui `{{output_N}}` pelos outputs registrados do lote corrente
  - Estado exposto: `meetingSummary` (string), `filaSilenciosa` (array), `executedActions` (array), `transcriptLog` (array de chunks recebidos)
  - Erros de `runFn` (timeout) e JSON inválido: janela descartada silenciosamente (só `'status'` emitido), nunca lança

- [ ] **Step 1: Escrever teste que falha**

```js
// test/dispatcher.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher } from '../lib/dispatcher.js';

const reply = (obj) => async () => JSON.stringify(obj);

test('urgência alta emite suggestion; baixa vai para fila silenciosa', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'Buscar dado', skill: 'busca', argumento: 'X', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'Registrar depois', skill: 'crm', argumento: 'Y', depende_de: null, urgencia: 'baixa' },
      ],
      alerta: null,
      summaryUpdate: 'Discutindo X.',
    }),
    skillsCardapio: '- busca: b\n- crm: c',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('falando sobre X');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].skill, 'busca');
  assert.equal(d.filaSilenciosa.length, 1);
  assert.equal(d.meetingSummary.trim(), 'Discutindo X.');
});

test('cadeia: aprovar resolve {{output_N}}; recusar cancela dependentes', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'Buscar', skill: 'busca', argumento: 'Empresa Exemplo', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'Atualizar', skill: 'atualiza', argumento: '{{output_1}}', depende_de: 1, urgencia: 'alta' },
        { ordem: 3, proposta: 'Independente', skill: 'outra', argumento: 'Z', depende_de: null, urgencia: 'alta' },
      ],
      alerta: null,
      summaryUpdate: 's',
    }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1); // uma por vez

  const a1 = d.resolveDecision(suggestions[0].id, true);
  assert.equal(a1.skill, 'busca');
  d.recordResult(suggestions[0].id, 'dados do parceiro');
  assert.equal(suggestions.length, 2); // próxima da fila emitida
  const a2 = d.resolveDecision(suggestions[1].id, true);
  assert.equal(a2.argumento, 'dados do parceiro'); // {{output_1}} resolvido
  d.recordResult(suggestions[1].id, 'ok');
  assert.equal(suggestions.length, 3);
});

test('recusar N cancela dependentes transitivos, independentes seguem', async () => {
  const d = new Dispatcher({
    runFn: reply({
      acoes: [
        { ordem: 1, proposta: 'A', skill: 'a', argumento: 'x', depende_de: null, urgencia: 'alta' },
        { ordem: 2, proposta: 'B', skill: 'b', argumento: '{{output_1}}', depende_de: 1, urgencia: 'alta' },
        { ordem: 3, proposta: 'C', skill: 'c', argumento: '{{output_2}}', depende_de: 2, urgencia: 'alta' },
        { ordem: 4, proposta: 'D', skill: 'd', argumento: 'w', depende_de: null, urgencia: 'alta' },
      ],
      alerta: null,
      summaryUpdate: 's',
    }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(d.resolveDecision(suggestions[0].id, false), null); // recusa A
  // B e C cancelados; próxima emitida é D
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[1].skill, 'd');
});

test('JSON inválido e erro do runFn não lançam', async () => {
  const bad = new Dispatcher({ runFn: async () => 'não é json', skillsCardapio: '' });
  await bad.handleChunk('x'); // não lança
  const err = new Dispatcher({ runFn: async () => { throw new Error('timeout'); }, skillsCardapio: '' });
  await err.handleChunk('x'); // não lança
  assert.ok(true);
});

test('alerta emite suggestion com urgencia alerta', async () => {
  const d = new Dispatcher({
    runFn: reply({ acoes: [], alerta: 'Risco contratual sendo discutido', summaryUpdate: 's' }),
    skillsCardapio: '',
  });
  const suggestions = [];
  d.on('suggestion', (s) => suggestions.push(s));
  await d.handleChunk('x');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].urgencia, 'alerta');
  assert.equal(suggestions[0].skill, null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/dispatcher.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/dispatcher.js**

O prompt DEVE ser copiado verbatim do spec (seção "Prompt do Dispatcher (final)").

```js
import { EventEmitter } from 'node:events';
import { parseJsonLoose } from './claude-client.js';
import config from './config.js';

const DISPATCHER_PROMPT = `Você é uma secretária executiva inteligente rodando durante uma reunião ao vivo em português.

Sua postura: discreta, atenta, age só quando necessário agora.
Durante a reunião, interrompa apenas para o que não pode esperar.
Registre todo o resto — será executado automaticamente ao encerrar.

A cada 30 segundos analise o trecho e decida:
- Isso precisa acontecer AGORA para não prejudicar a reunião? → urgencia "alta"
- Isso pode esperar o encerramento? → urgencia "baixa" (vai para fila silenciosa)
- Não é acionável ainda? → não proponha

RESUMO DA REUNIÃO ATÉ AGORA:
{meetingSummary}

TRECHO ATUAL (últimos 30s):
{transcriptChunk}

SKILLS DISPONÍVEIS:
{skillsCardapio}

Responda APENAS com JSON válido, sem texto adicional:
{
  "acoes": [
    {
      "ordem": 1,
      "proposta": "<descrição curta e imperativa>",
      "skill": "<nome exato da skill>",
      "argumento": "<argumento>",
      "depende_de": null,
      "urgencia": "alta"
    }
  ],
  "alerta": "<situação crítica que exige atenção imediata, ou null>",
  "summaryUpdate": "<1-2 frases atualizando o resumo da reunião>"
}

Regras:
- urgencia "alta": interrompe agora — use apenas se adiar comprometer a reunião
- urgencia "baixa": vai para fila silenciosa, executada automaticamente ao encerrar
- Se recusar skill N, skills com "depende_de": N são canceladas; independentes continuam
- Alertas só para riscos reais ou decisões irreversíveis sendo tomadas agora
- Nunca invente nomes de skills
- "summaryUpdate" é obrigatório sempre
- Responda sempre em português`;

let nextId = 1;

export class Dispatcher extends EventEmitter {
  constructor({ runFn, skillsCardapio, model = config.dispatcherModel, timeoutMs = config.dispatcherTimeoutMs }) {
    super();
    this.runFn = runFn;
    this.skillsCardapio = skillsCardapio;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.meetingSummary = '';
    this.filaSilenciosa = [];
    this.executedActions = [];
    this.transcriptLog = [];
    this.pendingQueue = []; // ações alta aguardando aprovação, uma exibida por vez
    this.active = null; // suggestion atualmente exibida
    this.batchOutputs = {}; // ordem → output (por lote)
  }

  buildPrompt(chunkText) {
    return DISPATCHER_PROMPT
      .replace('{meetingSummary}', this.meetingSummary || '(início da reunião)')
      .replace('{transcriptChunk}', chunkText)
      .replace('{skillsCardapio}', this.skillsCardapio || '(nenhuma skill disponível)');
  }

  async handleChunk(chunkText) {
    this.transcriptLog.push(chunkText);
    let raw;
    try {
      raw = await this.runFn(this.buildPrompt(chunkText), { model: this.model, timeoutMs: this.timeoutMs });
    } catch (err) {
      this.emit('status', `janela descartada: ${err.message}`);
      return;
    }
    const parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed.summaryUpdate !== 'string') {
      this.emit('status', 'janela descartada: resposta inválida');
      return;
    }
    this.meetingSummary = `${this.meetingSummary}\n${parsed.summaryUpdate}`.trim();
    this.batchOutputs = {}; // novo lote de ações
    for (const acao of parsed.acoes ?? []) {
      const item = { id: nextId++, ...acao };
      if (acao.urgencia === 'baixa') this.filaSilenciosa.push(item);
      else this.pendingQueue.push(item);
    }
    if (parsed.alerta) {
      this.pendingQueue.push({ id: nextId++, ordem: null, proposta: parsed.alerta, skill: null, argumento: null, depende_de: null, urgencia: 'alerta' });
    }
    this.emitNext();
  }

  emitNext() {
    if (this.active || !this.pendingQueue.length) return;
    this.active = this.pendingQueue.shift();
    this.emit('suggestion', this.active);
  }

  resolveArgument(arg) {
    if (typeof arg !== 'string') return arg;
    return arg.replace(/\{\{output_(\d+)\}\}/g, (_, n) => this.batchOutputs[n] ?? '');
  }

  resolveDecision(id, approved) {
    if (!this.active || this.active.id !== id) return null;
    const action = this.active;
    this.active = null;
    if (!approved) {
      this.cancelDependents(action.ordem);
      this.emitNext();
      return null;
    }
    if (action.urgencia === 'alerta') {
      this.emitNext();
      return null; // alerta não executa skill
    }
    return { ...action, argumento: this.resolveArgument(action.argumento) };
  }

  cancelDependents(ordem) {
    if (ordem == null) return;
    const cancelled = new Set([ordem]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of this.pendingQueue) {
        if (a.depende_de != null && cancelled.has(a.depende_de) && !cancelled.has(a.ordem)) {
          cancelled.add(a.ordem);
          changed = true;
        }
      }
    }
    cancelled.delete(ordem);
    this.pendingQueue = this.pendingQueue.filter((a) => !cancelled.has(a.ordem));
  }

  recordResult(id, output) {
    const done = this.executedActions.find((a) => a.id === id) ?? null;
    if (!done) {
      // encontra a ação pelos registros: foi a última aprovada com esse id
      this.executedActions.push({ id, output });
    }
    // outputs por ordem para {{output_N}} — procura ordem da ação nos lotes
    const known = [...this.executedActions];
    for (const a of known) if (a.ordem != null) this.batchOutputs[a.ordem] = a.output;
    this.emitNext();
  }
}
```

**Atenção ao implementar:** `recordResult` precisa do `ordem` da ação — ajuste `resolveDecision` para guardar a ação aprovada num mapa `this.approved = new Map()` (`id → action`) e em `recordResult` faça:

```js
  recordResult(id, output) {
    const action = this.approved?.get(id);
    if (action) {
      this.executedActions.push({ ...action, output });
      if (action.ordem != null) this.batchOutputs[action.ordem] = output;
      this.approved.delete(id);
    }
    this.emitNext();
  }
```

e em `resolveDecision`, antes do `return`:

```js
    if (!this.approved) this.approved = new Map();
    const resolved = { ...action, argumento: this.resolveArgument(action.argumento) };
    this.approved.set(id, resolved);
    return resolved;
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/dispatcher.test.js`
Expected: PASS (5 testes)

- [ ] **Step 5: Commit**

```bash
git add lib/dispatcher.js test/dispatcher.test.js
git commit -m "feat: dispatcher com urgências, fila silenciosa e cadeias com dependência"
```

---

### Task 7: Executor de skills (`lib/executor.js`)

**Files:**
- Create: `lib/executor.js`
- Test: `test/executor.test.js`

**Interfaces:**
- Consumes: `runFn` injetado (assinatura de `runClaude`)
- Produces:
  - `executeSkill({ skill, argumento }, { projectPath, runFn, timeoutMs }) → Promise<string>` — prompt: `Use a skill "<skill>" com este argumento: <argumento>\nExecute a tarefa completamente e responda com um resumo conciso do resultado em português.` — roda com `cwd: projectPath` e `extraArgs: ['--permission-mode', 'acceptEdits']`

- [ ] **Step 1: Escrever teste que falha**

```js
// test/executor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../lib/executor.js';

test('executeSkill monta prompt com skill e argumento e usa cwd do projeto', async () => {
  const calls = [];
  const fakeRun = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return 'feito';
  };
  const out = await executeSkill(
    { skill: 'atualiza-crm', argumento: 'Empresa Exemplo' },
    { projectPath: 'C:/x/PRM', runFn: fakeRun, timeoutMs: 5000 },
  );
  assert.equal(out, 'feito');
  assert.match(calls[0].prompt, /atualiza-crm/);
  assert.match(calls[0].prompt, /Empresa Exemplo/);
  assert.equal(calls[0].opts.cwd, 'C:/x/PRM');
  assert.deepEqual(calls[0].opts.extraArgs, ['--permission-mode', 'acceptEdits']);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/executor.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/executor.js**

```js
import { runClaude } from './claude-client.js';
import config from './config.js';

export async function executeSkill({ skill, argumento }, { projectPath, runFn = runClaude, timeoutMs = config.executorTimeoutMs }) {
  const prompt = `Use a skill "${skill}" com este argumento: ${argumento ?? '(sem argumento)'}\nExecute a tarefa completamente e responda com um resumo conciso do resultado em português.`;
  return runFn(prompt, {
    cwd: projectPath,
    timeoutMs,
    extraArgs: ['--permission-mode', 'acceptEdits'],
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/executor.test.js`
Expected: PASS (1 teste)

- [ ] **Step 5: Commit**

```bash
git add lib/executor.js test/executor.test.js
git commit -m "feat: executor de skills via claude -p no diretório do projeto"
```

---

### Task 8: Output Generator (`lib/output-generator.js`)

**Files:**
- Create: `lib/output-generator.js`
- Test: `test/output-generator.test.js`

**Interfaces:**
- Consumes: `runFn` injetado, `executeSkill` (Task 7, injetável como `execFn`), `parseJsonLoose` (Task 4)
- Produces:
  - `generateClosing({ transcript, executedActions, filaSilenciosa, projectPath }, { runFn, execFn, outputsDir, now }) → Promise<{ report, executionResults, savedPath }>`
    - Monta o prompt de encerramento VERBATIM do spec, chama `runFn` (timeout 120s, modelo padrão)
    - Parseia o JSON (`report`); se inválido, lança `Error('relatório inválido')`
    - Executa `report.executar_agora` em ordem topológica simples (independentes primeiro; `{{output_N}}` resolvido pelos resultados de itens anteriores do próprio array, indexados por posição 1-based)
    - Salva markdown em `<outputsDir>/YYYY-MM-DD-HH-MM.md` com sumário, tom, próximos passos, registro CRM e resultados de execução
    - Retorna `{ report, executionResults: [{ skill, argumento, output|error }], savedPath }`

- [ ] **Step 1: Escrever teste que falha**

```js
// test/output-generator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateClosing } from '../lib/output-generator.js';

const REPORT = {
  sumario: 'Reunião sobre Empresa Exemplo.',
  tom_da_reuniao: 'produtiva',
  proximos_passos: [{ acao: 'Enviar contrato', responsavel: 'Usuário', prazo: null }],
  registro_crm: { data: '2026-07-18', participantes: ['Usuário'], assunto: 'Empresa Exemplo', outcome: 'decidido', notas: 'ok' },
  executar_agora: [
    { skill: 'busca', argumento: 'Empresa Exemplo', depende_de: null },
    { skill: 'atualiza-crm', argumento: '{{output_1}}', depende_de: 1 },
  ],
};

test('generateClosing executa cadeia com dependência e salva markdown', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-out-'));
  const executed = [];
  const result = await generateClosing(
    { transcript: 'fala1\nfala2', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x' },
    {
      runFn: async () => JSON.stringify(REPORT),
      execFn: async ({ skill, argumento }) => {
        executed.push({ skill, argumento });
        return `resultado-${skill}`;
      },
      outputsDir,
      now: new Date('2026-07-18T14:30:00'),
    },
  );
  assert.equal(executed.length, 2);
  assert.equal(executed[1].argumento, 'resultado-busca'); // {{output_1}} resolvido
  assert.equal(result.report.tom_da_reuniao, 'produtiva');
  assert.ok(fs.existsSync(result.savedPath));
  const md = fs.readFileSync(result.savedPath, 'utf8');
  assert.match(md, /Reunião sobre Empresa Exemplo/);
  assert.match(md, /registro_crm|Registro CRM/i);
});

test('generateClosing lança com relatório inválido', async () => {
  await assert.rejects(
    generateClosing(
      { transcript: 'x', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x' },
      { runFn: async () => 'lixo', execFn: async () => '', outputsDir: os.tmpdir(), now: new Date() },
    ),
    /relatório inválido/,
  );
});

test('falha em uma skill não interrompe as demais', async () => {
  const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-out2-'));
  const result = await generateClosing(
    { transcript: 'x', executedActions: [], filaSilenciosa: [], projectPath: 'C:/x' },
    {
      runFn: async () => JSON.stringify({
        ...REPORT,
        executar_agora: [
          { skill: 'quebra', argumento: 'a', depende_de: null },
          { skill: 'funciona', argumento: 'b', depende_de: null },
        ],
      }),
      execFn: async ({ skill }) => {
        if (skill === 'quebra') throw new Error('boom');
        return 'ok';
      },
      outputsDir,
      now: new Date(),
    },
  );
  assert.equal(result.executionResults.length, 2);
  assert.match(result.executionResults[0].error, /boom/);
  assert.equal(result.executionResults[1].output, 'ok');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/output-generator.test.js`
Expected: FAIL (módulo não existe)

- [ ] **Step 3: Implementar lib/output-generator.js**

O prompt DEVE ser copiado verbatim do spec (seção "Prompt de Encerramento (final)").

```js
import fs from 'node:fs';
import path from 'node:path';
import { runClaude, parseJsonLoose } from './claude-client.js';
import { executeSkill } from './executor.js';
import config from './config.js';

const CLOSING_PROMPT = `Você é uma secretária executiva. A reunião encerrou.
Execute o pacote completo de encerramento sem precisar de confirmação.

TRANSCRIPT COMPLETO:
{transcriptCompleto}

AÇÕES EXECUTADAS DURANTE A REUNIÃO:
{acoesExecutadas}

FILA SILENCIOSA (registrada durante a reunião para executar agora):
{filaSilenciosa}

DATA DE HOJE: {dataHoje}

Gere um JSON com a seguinte estrutura:

{
  "sumario": "<3-5 frases objetivas: o que foi discutido, o que foi decidido>",
  "tom_da_reuniao": "produtiva | tensa | inconclusiva",
  "proximos_passos": [
    {
      "acao": "<compromisso claro mencionado na reunião>",
      "responsavel": "<nome ou null>",
      "prazo": "<prazo mencionado ou null>"
    }
  ],
  "registro_crm": {
    "data": "{dataHoje}",
    "participantes": ["<nomes inferidos do transcript>"],
    "assunto": "<tema principal>",
    "outcome": "decidido | em andamento | sem conclusão",
    "notas": "<observações relevantes>"
  },
  "executar_agora": [
    {
      "skill": "<nome exato da skill>",
      "argumento": "<argumento>",
      "depende_de": null
    }
  ]
}

Regras:
- "executar_agora" inclui toda a fila silenciosa + registro CRM + próximos passos acionáveis
- Ordene por dependência — skills independentes primeiro
- Participantes: infira do transcript, nunca invente
- Sumário máximo 5 frases, objetivo
- Responda sempre em português`;

function pad(n) { return String(n).padStart(2, '0'); }

export async function generateClosing(
  { transcript, executedActions, filaSilenciosa, projectPath },
  { runFn = runClaude, execFn = executeSkill, outputsDir = config.outputsDir, now = new Date() } = {},
) {
  const dataHoje = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const prompt = CLOSING_PROMPT
    .replaceAll('{dataHoje}', dataHoje)
    .replace('{transcriptCompleto}', transcript || '(sem transcript)')
    .replace('{acoesExecutadas}', JSON.stringify(executedActions ?? [], null, 2))
    .replace('{filaSilenciosa}', JSON.stringify(filaSilenciosa ?? [], null, 2));

  const raw = await runFn(prompt, { timeoutMs: config.executorTimeoutMs });
  const report = parseJsonLoose(raw);
  if (!report || typeof report.sumario !== 'string') throw new Error('relatório inválido');

  const executionResults = [];
  const outputs = {}; // posição 1-based → output
  for (const [i, item] of (report.executar_agora ?? []).entries()) {
    const argumento = String(item.argumento ?? '').replace(/\{\{output_(\d+)\}\}/g, (_, n) => outputs[n] ?? '');
    try {
      const output = await execFn({ skill: item.skill, argumento }, { projectPath });
      outputs[i + 1] = output;
      executionResults.push({ skill: item.skill, argumento, output });
    } catch (err) {
      executionResults.push({ skill: item.skill, argumento, error: err.message });
    }
  }

  fs.mkdirSync(outputsDir, { recursive: true });
  const savedPath = path.join(outputsDir, `${dataHoje}-${pad(now.getHours())}-${pad(now.getMinutes())}.md`);
  const md = [
    `# Reunião ${dataHoje} — ${report.registro_crm?.assunto ?? ''}`,
    ``, `## Sumário`, report.sumario, ``, `**Tom:** ${report.tom_da_reuniao}`,
    ``, `## Próximos passos`,
    ...(report.proximos_passos ?? []).map((p) => `- ${p.acao} (responsável: ${p.responsavel ?? '—'}, prazo: ${p.prazo ?? '—'})`),
    ``, `## Registro CRM`, '```json', JSON.stringify(report.registro_crm, null, 2), '```',
    ``, `## Execuções no encerramento`,
    ...executionResults.map((r) => `- ${r.skill}: ${r.error ? `ERRO — ${r.error}` : r.output}`),
  ].join('\n');
  fs.writeFileSync(savedPath, md, 'utf8');

  return { report, executionResults, savedPath };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/output-generator.test.js`
Expected: PASS (3 testes)

- [ ] **Step 5: Rodar a suíte completa e commitar**

Run: `node --test test/`
Expected: PASS (todos)

```bash
git add lib/output-generator.js test/output-generator.test.js
git commit -m "feat: encerramento com relatório, CRM e execução automática da fila"
```

---

### Task 9: Overlay Electron — janela, preload e modo Reunião

**Files:**
- Create: `overlay/main.js`, `overlay/preload.js`, `overlay/renderer/index.html`, `overlay/renderer/app.js`, `overlay/renderer/style.css`, `start.js`

**Interfaces:**
- Consumes: todos os módulos `lib/` (Tasks 2–8)
- Produces: canais IPC —
  - main→renderer: `suggestion` (objeto do Dispatcher), `result` `{ id, output|error }`, `status` `{ text }`, `closing-report` `{ report, executionResults, savedPath }`, `meeting-state` `{ project, running }`
  - renderer→main: `decision` `{ id, approved }`, `chat` `{ text }` (responde com `result`), `end-meeting`, `get-store`, `save-project` `{ name, path, skills }`, `delete-project` `{ name }`, `scan-skills` `{ path }`, `save-settings` `{ meetilyDbPath }`, `pick-folder`, `set-ignore-mouse` `{ ignore }`, `start-meeting` `{ project }`
- Comportamento do overlay (spec): 320×480, canto inferior direito, `transparent/frame:false/alwaysOnTop/skipTaskbar`, click-through quando sem proposta (`setIgnoreMouseEvents(true, { forward: true })`), beep via Web Audio ao receber suggestion, timeout de 15s descarta proposta (envia `decision {approved:false}`), Enter aprova/Esc descarta, campo de chat fixo, histórico de 5 itens

- [ ] **Step 1: Escrever overlay/main.js**

```js
import { app, BrowserWindow, ipcMain, dialog, clipboard, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, saveStore, upsertProject, deleteProject, getProject } from '../lib/projects.js';
import { scanSkills, buildCardapio } from '../lib/skills.js';
import { runClaude } from '../lib/claude-client.js';
import { Watcher } from '../lib/watcher.js';
import { Dispatcher } from '../lib/dispatcher.js';
import { executeSkill } from '../lib/executor.js';
import { generateClosing } from '../lib/output-generator.js';
import config from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let session = null; // { project, watcher, dispatcher }

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 320, height: 480, x: width - 340, y: height - 500,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) { win?.webContents.send(channel, payload); }

async function startMeeting(projectName) {
  const store = loadStore();
  const project = getProject(store, projectName);
  if (!project) { send('status', { text: `Projeto "${projectName}" não encontrado. Abra Config.` }); return; }
  if (!store.settings.meetilyDbPath) { send('status', { text: 'Configure o caminho do banco do Meetily em Config.' }); return; }

  const skills = scanSkills(project.path);
  const cardapio = buildCardapio(skills, project.skills?.length ? project.skills : null);
  const dispatcher = new Dispatcher({ runFn: runClaude, skillsCardapio: cardapio });
  const watcher = new Watcher({ dbPath: store.settings.meetilyDbPath });

  watcher.on('transcript-chunk', (c) => dispatcher.handleChunk(c.text));
  watcher.on('watcher-error', (e) => send('status', { text: `Meetily indisponível: ${e.message}` }));
  dispatcher.on('suggestion', (s) => send('suggestion', s));
  dispatcher.on('status', (t) => send('status', { text: t }));

  session = { project, watcher, dispatcher };
  await watcher.start();
  send('meeting-state', { project: project.name, running: true });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('get-store', () => loadStore());
  ipcMain.handle('scan-skills', (_e, { path: p }) => scanSkills(p));
  ipcMain.handle('save-project', (_e, project) => { const s = upsertProject(loadStore(), project); saveStore(s); return s; });
  ipcMain.handle('delete-project', (_e, { name }) => { const s = deleteProject(loadStore(), name); saveStore(s); return s; });
  ipcMain.handle('save-settings', (_e, { meetilyDbPath }) => {
    const s = loadStore(); s.settings.meetilyDbPath = meetilyDbPath; saveStore(s); return s;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('set-ignore-mouse', (_e, { ignore }) => win.setIgnoreMouseEvents(ignore, { forward: true }));
  ipcMain.handle('start-meeting', (_e, { project }) => startMeeting(project));

  ipcMain.on('decision', async (_e, { id, approved }) => {
    if (!session) return;
    const action = session.dispatcher.resolveDecision(id, approved);
    if (!action) return;
    try {
      const output = await executeSkill(action, { projectPath: session.project.path });
      session.dispatcher.recordResult(id, output);
      send('result', { id, output });
    } catch (err) {
      session.dispatcher.recordResult(id, `erro: ${err.message}`);
      send('result', { id, error: err.message });
    }
  });

  ipcMain.on('chat', async (_e, { text }) => {
    const ctx = session ? `Contexto da reunião até agora:\n${session.dispatcher.meetingSummary}\n\n` : '';
    try {
      const output = await runClaude(`${ctx}Mensagem do usuário durante a reunião: ${text}\nResponda de forma curta, em português.`, {
        cwd: session?.project.path, timeoutMs: config.executorTimeoutMs,
      });
      send('result', { id: `chat-${Date.now()}`, output });
    } catch (err) {
      send('result', { id: `chat-${Date.now()}`, error: err.message });
    }
  });

  ipcMain.on('end-meeting', async () => {
    if (!session) return;
    session.watcher.stop();
    send('status', { text: 'Gerando encerramento…' });
    try {
      const result = await generateClosing({
        transcript: session.dispatcher.transcriptLog.join('\n'),
        executedActions: session.dispatcher.executedActions,
        filaSilenciosa: session.dispatcher.filaSilenciosa,
        projectPath: session.project.path,
      });
      clipboard.writeText(JSON.stringify(result.report.registro_crm, null, 2));
      send('closing-report', result);
    } catch (err) {
      send('status', { text: `Falha no encerramento: ${err.message}` });
    }
    session = null;
    send('meeting-state', { project: null, running: false });
  });

  const projArg = process.argv.find((a) => a.startsWith('--project='));
  if (projArg) startMeeting(projArg.split('=')[1]);
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 2: Escrever overlay/preload.cjs** (CommonJS — preload não suporta ESM em sandbox)

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  on: (channel, cb) => {
    const valid = ['suggestion', 'result', 'status', 'closing-report', 'meeting-state'];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  decision: (id, approved) => ipcRenderer.send('decision', { id, approved }),
  chat: (text) => ipcRenderer.send('chat', { text }),
  endMeeting: () => ipcRenderer.send('end-meeting'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', { ignore }),
  getStore: () => ipcRenderer.invoke('get-store'),
  scanSkills: (path) => ipcRenderer.invoke('scan-skills', { path }),
  saveProject: (p) => ipcRenderer.invoke('save-project', p),
  deleteProject: (name) => ipcRenderer.invoke('delete-project', { name }),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  startMeeting: (project) => ipcRenderer.invoke('start-meeting', { project }),
});
```

- [ ] **Step 3: Escrever overlay/renderer/index.html**

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="style.css" />
  <title>Meeting Agent</title>
</head>
<body>
  <div id="app">
    <header id="bar">
      <span id="title">Meeting Agent</span>
      <span id="meeting-label"></span>
      <button id="btn-config" title="Configurações">⚙</button>
      <button id="btn-end" title="Encerrar reunião" hidden>■</button>
    </header>

    <main id="view-meeting">
      <div id="history"></div>
      <div id="proposal" hidden>
        <p id="proposal-text"></p>
        <div class="actions">
          <button id="btn-approve">Executar (Enter)</button>
          <button id="btn-reject">Ignorar (Esc)</button>
        </div>
      </div>
      <div id="status"></div>
      <form id="chat-form">
        <input id="chat-input" type="text" placeholder="Falar com o agente…" autocomplete="off" />
      </form>
    </main>

    <main id="view-config" hidden>
      <h2>Configurações</h2>
      <label>Banco do Meetily
        <input id="cfg-dbpath" type="text" placeholder="C:\…\meetily.db" />
      </label>
      <button id="cfg-save-settings">Salvar caminho</button>
      <h2>Projetos</h2>
      <ul id="project-list"></ul>
      <h3 id="form-title">Novo projeto</h3>
      <label>Nome <input id="p-name" type="text" /></label>
      <label>Pasta <button id="p-pick" type="button">Escolher pasta…</button> <span id="p-path"></span></label>
      <div id="p-skills"></div>
      <button id="p-save">Salvar projeto</button>
      <h2>Iniciar reunião</h2>
      <select id="start-select"></select>
      <button id="btn-start">Iniciar</button>
    </main>

    <main id="view-closing" hidden>
      <h2>Encerramento</h2>
      <pre id="closing-content"></pre>
      <button id="btn-close-report">Fechar</button>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Escrever overlay/renderer/style.css**

```css
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; height: 100%; overflow: hidden; }
body { font: 13px/1.4 Consolas, monospace; color: #fff; }
#app { display: flex; flex-direction: column; height: 100%; background: rgba(0,0,0,.7); border-radius: 12px; padding: 8px; }
body.config-mode #app { background: rgb(20,20,26); }
#bar { display: flex; gap: 6px; align-items: center; -webkit-app-region: drag; padding-bottom: 6px; }
#bar button { -webkit-app-region: no-drag; }
#title { font-weight: bold; }
#meeting-label { color: #7fd47f; flex: 1; font-size: 11px; }
button { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.25); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
button:hover { background: rgba(255,255,255,.25); }
main { flex: 1; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
#history { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.entry { background: rgba(255,255,255,.08); border-radius: 8px; padding: 6px; white-space: pre-wrap; }
.entry.err { border-left: 3px solid #e66; }
.entry.ok { border-left: 3px solid #7fd47f; }
#proposal { background: rgba(40,60,120,.85); border-radius: 10px; padding: 10px; }
#proposal .actions { display: flex; gap: 8px; margin-top: 8px; }
#status { color: #aaa; font-size: 11px; min-height: 14px; }
#chat-form input { width: 100%; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); border-radius: 8px; color: #fff; padding: 6px; }
#view-config label { display: block; margin: 6px 0; }
#view-config input[type=text] { width: 100%; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); color: #fff; padding: 4px; border-radius: 6px; }
#project-list li { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
#closing-content { white-space: pre-wrap; overflow: auto; flex: 1; background: rgba(255,255,255,.06); padding: 8px; border-radius: 8px; }
```

- [ ] **Step 5: Escrever overlay/renderer/app.js**

```js
const $ = (id) => document.getElementById(id);
let activeProposal = null;
let proposalTimer = null;

function beep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
}

function addHistory(text, cls = '') {
  const div = document.createElement('div');
  div.className = `entry ${cls}`;
  div.textContent = text;
  const h = $('history');
  h.appendChild(div);
  while (h.children.length > 5) h.removeChild(h.firstChild);
  h.scrollTop = h.scrollHeight;
}

function updateMouseGate() {
  const interactive = activeProposal !== null
    || !$('view-config').hidden
    || !$('view-closing').hidden
    || document.activeElement === $('chat-input');
  window.agent.setIgnoreMouse(!interactive);
}

function showProposal(s) {
  activeProposal = s;
  const tag = s.urgencia === 'alerta' ? '⚠ ALERTA' : `▶ ${s.skill ?? ''}`;
  $('proposal-text').textContent = `${tag}\n${s.proposta}`;
  $('proposal').hidden = false;
  beep();
  updateMouseGate();
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(() => decide(false), 15000);
}

function decide(approved) {
  if (!activeProposal) return;
  clearTimeout(proposalTimer);
  window.agent.decision(activeProposal.id, approved);
  addHistory(`${approved ? '✓ aprovado' : '✗ ignorado'}: ${activeProposal.proposta}`, approved ? 'ok' : '');
  activeProposal = null;
  $('proposal').hidden = true;
  updateMouseGate();
}

window.agent.on('suggestion', showProposal);
window.agent.on('result', (r) => addHistory(r.error ? `erro: ${r.error}` : r.output, r.error ? 'err' : 'ok'));
window.agent.on('status', (s) => { $('status').textContent = s.text; });
window.agent.on('meeting-state', (m) => {
  $('meeting-label').textContent = m.running ? `● ${m.project}` : '';
  $('btn-end').hidden = !m.running;
});
window.agent.on('closing-report', ({ report, executionResults, savedPath }) => {
  $('view-meeting').hidden = true;
  $('view-config').hidden = true;
  $('view-closing').hidden = false;
  $('closing-content').textContent = [
    `SUMÁRIO\n${report.sumario}`,
    `TOM: ${report.tom_da_reuniao}`,
    `PRÓXIMOS PASSOS\n${(report.proximos_passos ?? []).map((p) => `- ${p.acao}`).join('\n')}`,
    `CRM (copiado para o clipboard)\n${JSON.stringify(report.registro_crm, null, 2)}`,
    `EXECUÇÕES\n${executionResults.map((r) => `- ${r.skill}: ${r.error ?? r.output}`).join('\n')}`,
    `Salvo em: ${savedPath}`,
  ].join('\n\n');
  updateMouseGate();
});

document.addEventListener('keydown', (e) => {
  if (!activeProposal) return;
  if (e.key === 'Enter' && document.activeElement !== $('chat-input')) decide(true);
  if (e.key === 'Escape') decide(false);
});

$('btn-approve').addEventListener('click', () => decide(true));
$('btn-reject').addEventListener('click', () => decide(false));
$('btn-end').addEventListener('click', () => window.agent.endMeeting());
$('btn-close-report').addEventListener('click', () => {
  $('view-closing').hidden = true;
  $('view-meeting').hidden = false;
  updateMouseGate();
});
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addHistory(`você: ${text}`);
  window.agent.chat(text);
  $('chat-input').value = '';
});
$('chat-input').addEventListener('focus', updateMouseGate);
$('chat-input').addEventListener('blur', updateMouseGate);

// ---------- Modo Config ----------
let editingPath = null;

async function refreshConfig() {
  const store = await window.agent.getStore();
  $('cfg-dbpath').value = store.settings.meetilyDbPath ?? '';
  const ul = $('project-list');
  ul.innerHTML = '';
  const sel = $('start-select');
  sel.innerHTML = '';
  for (const p of store.projects) {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.path}`;
    const del = document.createElement('button');
    del.textContent = 'excluir';
    del.addEventListener('click', async () => { await window.agent.deleteProject(p.name); refreshConfig(); });
    li.appendChild(del);
    ul.appendChild(li);
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
}

$('btn-config').addEventListener('click', () => {
  const showing = $('view-config').hidden;
  $('view-config').hidden = !showing;
  $('view-meeting').hidden = showing;
  document.body.classList.toggle('config-mode', showing);
  if (showing) refreshConfig();
  updateMouseGate();
});

$('cfg-save-settings').addEventListener('click', async () => {
  await window.agent.saveSettings({ meetilyDbPath: $('cfg-dbpath').value.trim() || null });
  $('status').textContent = 'Caminho salvo.';
});

$('p-pick').addEventListener('click', async () => {
  const folder = await window.agent.pickFolder();
  if (!folder) return;
  editingPath = folder;
  $('p-path').textContent = folder;
  const skills = await window.agent.scanSkills(folder);
  $('p-skills').innerHTML = skills.length
    ? skills.map((s) => `<label><input type="checkbox" checked value="${s.name}"> ${s.name} — ${s.description}</label>`).join('<br>')
    : '<em>Nenhuma skill encontrada em .claude/skills</em>';
});

$('p-save').addEventListener('click', async () => {
  const name = $('p-name').value.trim();
  if (!name || !editingPath) { $('status').textContent = 'Nome e pasta são obrigatórios.'; return; }
  const skills = [...$('p-skills').querySelectorAll('input:checked')].map((i) => i.value);
  await window.agent.saveProject({ name, path: editingPath, skills });
  $('p-name').value = '';
  $('p-path').textContent = '';
  $('p-skills').innerHTML = '';
  editingPath = null;
  refreshConfig();
});

$('btn-start').addEventListener('click', async () => {
  const project = $('start-select').value;
  if (!project) return;
  await window.agent.startMeeting(project);
  $('btn-config').click(); // volta ao modo reunião
});

updateMouseGate();
```

- [ ] **Step 6: Escrever start.js**

```js
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projArg = process.argv.find((a) => a === '--project') ? `--project=${process.argv[process.argv.indexOf('--project') + 1]}` : process.argv.find((a) => a.startsWith('--project=')) ?? '';
const electron = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
spawn(electron, ['.', projArg].filter(Boolean), { cwd: __dirname, stdio: 'inherit', shell: true });
```

- [ ] **Step 7: Smoke test manual do overlay**

Run: `npx electron . `
Expected: janela transparente no canto inferior direito, header "Meeting Agent", botão ⚙ abre o modo Config opaco com formulário de projetos. Fechar com Ctrl+C no terminal.
Se `transparent: true` falhar (janela preta), verificar aceleração de hardware — adicionar `app.disableHardwareAcceleration()` NO TOPO do `app.whenReady()` e retestar.

- [ ] **Step 8: Commit**

```bash
git add overlay/ start.js
git commit -m "feat: overlay transparente com modos Reunião e Config"
```

---

### Task 10: Script de simulação e teste E2E manual

**Files:**
- Create: `scripts/simulate.js`

**Interfaces:**
- Consumes: `sql.js`
- Produces: cria `%TEMP%\ma-sim\meetily.db` com tabela `transcript_segments` e insere falas de uma reunião fake a cada 5s (regrava o arquivo), simulando o Meetily. Imprime o caminho do DB no início para colar no Config.

- [ ] **Step 1: Escrever scripts/simulate.js**

```js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import initSqlJs from 'sql.js';

const FALAS = [
  'Bom dia pessoal, vamos começar a reunião de parceiros.',
  'O parceiro Empresa Exemplo pediu atualização do status de onboarding.',
  'Precisamos registrar isso no CRM e verificar os documentos pendentes.',
  'Também surgiu a questão da comissão do trimestre.',
  'Ficou decidido que o Usuário envia o contrato até sexta-feira.',
  'Ok, encerrando por aqui. Obrigado a todos.',
];

const dir = path.join(os.tmpdir(), 'ma-sim');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, 'meetily.db');

const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('CREATE TABLE transcript_segments (id INTEGER PRIMARY KEY, text TEXT, created_at TEXT)');
fs.writeFileSync(dbFile, Buffer.from(db.export()));
console.log(`Banco simulado: ${dbFile}`);
console.log('Cole esse caminho no Config do overlay e inicie uma reunião.');

let i = 0;
const timer = setInterval(() => {
  if (i >= FALAS.length) { clearInterval(timer); console.log('Simulação encerrada.'); return; }
  db.run('INSERT INTO transcript_segments (text, created_at) VALUES (?, ?)', [FALAS[i], new Date().toISOString()]);
  fs.writeFileSync(dbFile, Buffer.from(db.export()));
  console.log(`fala ${i + 1}: ${FALAS[i]}`);
  i += 1;
}, 5000);
```

- [ ] **Step 2: Teste E2E manual**

1. Terminal 1: `npm run simulate` — copiar o caminho impresso
2. Terminal 2: `npx electron . `
3. No overlay: ⚙ → colar caminho do banco → Salvar caminho → criar projeto de teste apontando para uma pasta com `.claude/skills` (pode usar uma pasta vazia — cardápio vazio é válido) → Iniciar
4. Expected: em ~30–60s o status mostra atividade; se o `claude` CLI estiver logado, o dispatcher responde (com cardápio vazio, provavelmente sem propostas — o teste valida o fluxo, não a proposta)
5. Clicar ■ (Encerrar): Expected — tela de encerramento com sumário gerado e CRM no clipboard

- [ ] **Step 3: Commit**

```bash
git add scripts/simulate.js
git commit -m "feat: simulador de reunião para teste E2E sem Meetily"
```

---

### Task 11: README e fechamento

**Files:**
- Create: `README.md`

- [ ] **Step 1: Escrever README.md**

```markdown
# Meeting Agent

Secretária executiva local para reuniões: transcreve via [Meetily](https://github.com/Zackriya-Solutions/meetily),
propõe e executa skills do Claude Code durante a reunião (aprovação de 1 toque)
e executa fila silenciosa + registro CRM automaticamente ao encerrar.

100% local — nenhum áudio ou transcript sai da máquina.

## Pré-requisitos
- Windows 11, Node 20+
- Meetily instalado e transcrevendo (banco SQLite local)
- Claude Code CLI logado (`claude`)

## Uso
1. `npm install`
2. `npx electron .` (ou `node start.js --project <nome>`)
3. ⚙ Config → caminho do banco do Meetily → cadastrar projetos → Iniciar reunião
4. Durante a reunião: Enter aprova proposta, Esc ignora, campo de texto conversa com o agente
5. ■ Encerrar → sumário + CRM (clipboard) + execução automática da fila silenciosa

## Teste sem Meetily
`npm run simulate` gera um banco fake com falas; cole o caminho impresso no Config.

## Testes
`npm test`
```

- [ ] **Step 2: Rodar a suíte completa**

Run: `node --test test/`
Expected: PASS (todos os testes das Tasks 2–8)

- [ ] **Step 3: Commit final**

```bash
git add README.md docs/
git commit -m "docs: README e documentos de design/plano"
```

---

## Self-Review (executado na escrita do plano)

- **Cobertura do spec:** captura/overlay (T9), watcher (T5), dispatcher com urgências/fila/cadeias (T6), executor (T7), encerramento com execução automática + clipboard (T8/T9), modo Config no overlay (T9/T10 — decisão C do usuário), inicialização por projeto (T9 `start-meeting` + `--project`), tratamento de erros (T5 watcher-error, T6 descarte silencioso, T8 falha isolada por skill, T9 banners de status). Diarização, multi-monitor, Slack: fora de escopo v1 conforme spec.
- **Placeholders:** nenhum TBD; todo step com código tem o código.
- **Consistência de tipos:** `runFn(prompt, opts)` uniforme entre client/dispatcher/executor/output-generator; eventos `suggestion/result/status/closing-report/meeting-state` idênticos entre main.js, preload e app.js; `{{output_N}}` resolvido no Dispatcher (lote por `ordem`) e no encerramento (posição 1-based) — semânticas documentadas em cada task.
- **Desvios conscientes do spec:** beep gerado via Web Audio (sem `assets/beep.mp3`); `chokidar` desnecessário (polling puro); `better-sqlite3` → `sql.js` (evita build nativo no Electron/Windows); preload em `.cjs`. Timeout de proposta (15s) e histórico (5 itens) conforme spec.
