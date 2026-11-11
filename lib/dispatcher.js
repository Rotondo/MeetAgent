import { EventEmitter } from 'node:events';
import { parseJsonLoose } from './claude-client.js';
import config from './config.js';
import { HIGH_PERFORMANCE_GUIDANCE } from './high-performance.js';
import { validateIntervention } from './meeting-domain.js';

const DISPATCHER_PROMPT = `Você é uma secretária executiva inteligente rodando durante uma reunião ao vivo em português.

Sua postura: discreta, atenta, age só quando necessário agora.
Durante a reunião, interrompa apenas para o que não pode esperar.
Registre todo o resto — será revisado e poderá ser aprovado ao encerrar.

TIPO DA REUNIÃO: {tipoReuniao}
RESUMO DA REUNIÃO ATÉ AGORA:
{meetingSummary}

TRECHO ATUAL (últimos 30s):
{transcriptChunk}

SKILLS DISPONÍVEIS:
{skillsCardapio}

CRITÉRIO TRANSVERSAL:
{guidance}

A cada janela você pode gerar até 3 tipos de interrupção (use com parcimônia):

1. AÇÕES (skills a executar) — só se realmente necessário agora ou ao encerrar
2. COACHING — 1 frase curta sobre como o usuário está conduzindo a conversa (tom, ritmo, cards revelados cedo, próximos passos vagos). Máximo 1 por janela. Só se houver algo concreto a dizer.
3. INSIGHT — informação de contexto útil agora (quem é essa empresa, o que significa esse termo, oportunidade identificada). Máximo 1 por janela.
4. PESQUISA — se alguém mencionar empresa ou produto que Usuário claramente não conhece bem, acione a skill "pesquisa-empresa" com o nome como argumento.
5. ALERTA — risco real ou decisão irreversível acontecendo agora.

Regras de volume por tipo de reunião:
- "exploratória": coaching ativo, insight ativo, pesquisa ativa
- "operacional": coaching desligado, insight mínimo, pesquisa desligada
- "contratual": coaching ativo, alerta muito ativo, insight mínimo
- "técnica": coaching desligado, insight ativo (termos técnicos), alerta ativo

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
  "alerta": "<situação crítica ou decisão irreversível agora, ou null>",
  "coaching": "<1 frase sobre como o usuário está conduzindo — ou null>",
  "insight": "<informação de contexto útil agora — ou null>",
  "pesquisa": "<nome de empresa/produto para pesquisar — ou null>",
  "deadline": "<prazo crítico mencionado na conversa (formato: 'YYYY-MM-DD: descrição') — ou null>",
  "summaryUpdate": "<1-2 frases atualizando o resumo da reunião>"
}

Regras:
- urgencia "alta": interrompe agora — use apenas se adiar comprometer a reunião
- urgencia "baixa": vai para fila silenciosa, exibida para aprovação ao encerrar
- Se recusar skill N, skills com "depende_de": N são canceladas; independentes continuam
- coaching: máximo 1 frase, direta, sem julgamento — "você revelou o valor do rebate antes de ouvir a proposta deles"
- insight: máximo 2 frases — fato relevante que muda como o usuário deve agir
- pesquisa: só o nome da empresa/produto — a skill faz o resto
- deadline: só datas concretas mencionadas na conversa
- "summaryUpdate" é obrigatório sempre
- Responda sempre em português`;

const PLAYBOOK_DISPATCHER_PROMPT = `Você é um copiloto discreto durante uma reunião ao vivo em português.

Seu trabalho não é resumir a conversa para o usuário nem avaliar a pessoa. Só intervenha quando houver uma próxima frase ou ação que melhore concretamente a condução agora.

ROTEIRO DA REUNIÃO:
{playbook}

ORIENTAÇÃO DE CONDUÇÃO:
{guidance}

RESUMO CANÔNICO ATÉ AGORA:
{meetingSummary}

QUADRO VIVO ATUAL:
{liveState}

TRECHO ATUAL:
{transcriptChunk}

ÚLTIMA INTERVENÇÃO MOSTRADA:
{lastIntervention}

Responda APENAS com JSON válido, sem texto adicional, neste formato:
{
  "intervencao": {
    "tipo": "pergunta|alerta|proximo_passo|nenhum",
    "ato": "<ato do roteiro que precisa de atenção>",
    "sugestao": "<frase pronta para o usuário dizer ou ação pronta para executar>",
    "motivo": "<por que isto ajuda a reunião agora>",
    "evidencia": "<fato concreto do trecho que justifica a intervenção>",
    "confidence": 0.9
  },
  "stateUpdate": {
    "decisoes": ["<decisão confirmada>"],
    "pendencias": ["<questão ou bloqueio ainda aberto>"],
    "compromissos": [{"acao":"<entrega>","responsavel":"<nome ou null>","prazo":"<prazo ou null>"}],
    "riscos": ["<risco concreto ainda ativo>"]
  },
  "summaryUpdate": "<resumo canônico, compacto e autocontido da reunião até agora>"
}

Regras:
- Produza no máximo uma intervenção. Use null quando nada mudar a próxima ação do usuário.
- Se usar "nenhum", devolva intervencao como null.
- A sugestão deve vir pronta para uso, ser curta e estar ligada ao ato atual do roteiro.
- Só intervenha com evidência concreta do trecho e confiança alta.
- Para alerta, exija risco real, compromisso ambíguo ou desvio que prejudique o resultado da agenda.
- Prefira pergunta de esclarecimento, proposta, pedido claro ou fechamento com responsável, prazo e condição de satisfação.
- Não entregue estatísticas de fala, contagens, velocidade, duração, placar, resumo ou comentário genérico como card.
- Não repita a última intervenção nem reformule o mesmo conselho.
- Considere decisões, pendências, responsáveis, prazos e dependências como estado persistente. Não cobre novamente algo já registrado.
- Em reuniões internas, prefira atualizar o quadro vivo silenciosamente. Um card só se justifica quando evita perda concreta de uma decisão ou compromisso.
- Não cite o nome da orientação de condução no card e não moralize.
- summaryUpdate é sempre obrigatório e substitui o resumo anterior; não acrescente histórico duplicado.
- stateUpdate é o estado canônico completo, não apenas a diferença da janela. Remova itens resolvidos e limite cada lista a 8 itens.
- Só registre decisão ou compromisso quando a fala sustentar isso. Se dono ou prazo não estiver explícito, use null.
- Responda sempre em português`;

let nextId = 1;

export class Dispatcher extends EventEmitter {
  constructor({
    runFn,
    skillsCardapio,
    tipoReuniao = 'exploratória',
    model = config.dispatcherModel,
    timeoutMs = config.dispatcherTimeoutMs,
    playbook = null,
    guidance = HIGH_PERFORMANCE_GUIDANCE,
    cooldownMs = config.liveInterventionCooldownMs,
    ttlMs = config.liveInterventionTtlMs,
    warmupWords = 0,
    semanticDedupeMs = 0,
    now = Date.now,
  }) {
    super();
    this.runFn = runFn;
    this.skillsCardapio = skillsCardapio;
    this.tipoReuniao = tipoReuniao;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.playbook = typeof playbook === 'string' ? playbook : playbook?.text ?? '';
    this.guidance = guidance || HIGH_PERFORMANCE_GUIDANCE;
    this.cooldownMs = cooldownMs;
    this.ttlMs = ttlMs;
    this.warmupWords = warmupWords;
    this.semanticDedupeMs = semanticDedupeMs;
    this.now = now;
    this.meetingSummary = '';
    this.filaSilenciosa = [];
    this.executedActions = [];
    this.transcriptLog = [];
    this.deadlines = []; // prazos críticos detectados ao vivo
    this.pendingQueue = []; // ações "alta" aguardando aprovação, uma exibida por vez
    this.active = null; // suggestion atualmente exibida no overlay
    this.approved = new Map(); // id → ação aprovada aguardando resultado
    this.batchOutputs = {}; // ordem → output do lote corrente (para {{output_N}})
    this.chunkQueue = [];
    this.processingPromise = null;
    this.lastPlaybookInterventionAt = null;
    this.lastPlaybookIntervention = '';
    this.playbookSignatures = new Set();
    this.deferredPlaybookText = '';
    this.observedWords = 0;
    this.interventionHistory = [];
    this.liveState = { decisoes: [], pendencias: [], compromissos: [], riscos: [] };
  }

  adaptContext({ playbook = this.playbook, tipoReuniao = this.tipoReuniao } = {}) {
    this.playbook = typeof playbook === 'string' ? playbook : playbook?.text ?? this.playbook;
    this.tipoReuniao = tipoReuniao;
  }

  _updateLiveState(value) {
    if (!value || typeof value !== 'object') return;
    const array = (candidate) => (Array.isArray(candidate) ? candidate.slice(0, 8) : []);
    this.liveState = {
      decisoes: array(value.decisoes),
      pendencias: array(value.pendencias),
      compromissos: array(value.compromissos),
      riscos: array(value.riscos),
    };
    this.emit('state', this.liveState);
  }

  buildPrompt(chunkText) {
    if (this.playbook) {
      return PLAYBOOK_DISPATCHER_PROMPT
        .replace('{playbook}', this.playbook)
        .replace('{guidance}', this.guidance)
        .replace('{meetingSummary}', this.meetingSummary || '(início da reunião)')
        .replace('{liveState}', JSON.stringify(this.liveState))
        .replace('{transcriptChunk}', chunkText)
        .replace('{lastIntervention}', this.lastPlaybookIntervention || '(nenhuma)');
    }
    return DISPATCHER_PROMPT
      .replace('{tipoReuniao}', this.tipoReuniao)
      .replace('{meetingSummary}', this.meetingSummary || '(início da reunião)')
      .replace('{transcriptChunk}', chunkText)
      .replace('{skillsCardapio}', this.skillsCardapio || '(nenhuma skill disponível)')
      .replace('{guidance}', this.guidance);
  }

  async handleChunk(chunkText) {
    this.transcriptLog.push(chunkText);
    this.chunkQueue.push(chunkText);
    if (!this.processingPromise) {
      this.processingPromise = this._drainChunks().finally(() => {
        this.processingPromise = null;
        if (this.chunkQueue.length) this.handleChunkQueue();
      });
    }
    return this.processingPromise;
  }

  handleChunkQueue() {
    if (this.processingPromise || !this.chunkQueue.length) return this.processingPromise;
    this.processingPromise = this._drainChunks().finally(() => {
      this.processingPromise = null;
      if (this.chunkQueue.length) this.handleChunkQueue();
    });
    return this.processingPromise;
  }

  async _drainChunks() {
    while (this.chunkQueue.length) {
      const chunkText = this.chunkQueue.splice(0).join('\n');
      await this._processChunk(chunkText);
    }
  }

  async _processChunk(chunkText) {
    this.observedWords += String(chunkText ?? '').trim().split(/\s+/).filter(Boolean).length;
    if (this.observedWords < this.warmupWords) {
      this.deferredPlaybookText = `${this.deferredPlaybookText}\n${chunkText}`.trim().slice(-12_000);
      return;
    }
    if (this.playbook) {
      const currentTime = this.now();
      const coolingDown = (
        this.lastPlaybookInterventionAt != null
        && currentTime - this.lastPlaybookInterventionAt < this.cooldownMs
      );
      if (coolingDown || this._hasLiveCard()) {
        this.deferredPlaybookText = `${this.deferredPlaybookText}\n${chunkText}`.trim().slice(-12_000);
        return;
      }
      if (this.deferredPlaybookText) {
        chunkText = `${this.deferredPlaybookText}\n${chunkText}`.trim().slice(-12_000);
        this.deferredPlaybookText = '';
      }
    }
    let raw;
    try {
      raw = await this.runFn(this.buildPrompt(chunkText), { model: this.model, timeoutMs: this.timeoutMs, purpose: 'dispatcher' });
    } catch (err) {
      this.emit('status', `janela descartada: ${err.message}`);
      return;
    }
    const parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed.summaryUpdate !== 'string') {
      this.emit('status', 'janela descartada: resposta inválida');
      return;
    }
    if (this.playbook) {
      this.meetingSummary = parsed.summaryUpdate.trim();
      this._updateLiveState(parsed.stateUpdate);
      this._enqueuePlaybookIntervention(parsed.intervencao);
      this.emitNext();
      return;
    }
    this.meetingSummary = `${this.meetingSummary}\n${parsed.summaryUpdate}`.trim();
    this.batchOutputs = {}; // novo lote de ações

    // Ações de skill (alta/baixa)
    for (const acao of parsed.acoes ?? []) {
      const item = { id: nextId++, ...acao };
      if (acao.urgencia === 'baixa') this.filaSilenciosa.push(item);
      else this.pendingQueue.push(item);
    }

    // Alerta: risco real ou decisão irreversível
    if (parsed.alerta) {
      this.pendingQueue.push({
        id: nextId++, ordem: null, proposta: parsed.alerta,
        skill: null, argumento: null, depende_de: null, urgencia: 'alerta',
      });
    }

    // Coaching: como o usuário está conduzindo
    if (parsed.coaching) {
      this.pendingQueue.push({
        id: nextId++, ordem: null, proposta: parsed.coaching,
        skill: null, argumento: null, depende_de: null, urgencia: 'coaching',
      });
    }

    // Insight: contexto relevante
    if (parsed.insight) {
      this.pendingQueue.push({
        id: nextId++, ordem: null, proposta: parsed.insight,
        skill: null, argumento: null, depende_de: null, urgencia: 'insight',
      });
    }

    // Pesquisa: empresa/produto para pesquisar via skill
    if (parsed.pesquisa) {
      this.pendingQueue.push({
        id: nextId++, ordem: null, proposta: `Pesquisar: ${parsed.pesquisa}`,
        skill: 'pesquisa-empresa', argumento: parsed.pesquisa, depende_de: null, urgencia: 'alta',
      });
    }

    // Deadline: prazo crítico detectado
    if (parsed.deadline) {
      this.deadlines.push(parsed.deadline);
      this.pendingQueue.push({
        id: nextId++, ordem: null, proposta: `⏰ PRAZO: ${parsed.deadline}`,
        skill: null, argumento: null, depende_de: null, urgencia: 'alerta',
      });
    }

    this.emitNext();
  }

  _normalizeSignature(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  _semanticTokens(value) {
    const generic = new Set([
      'usuário', 'podemos', 'pode', 'definir', 'confirme', 'confirmar', 'responsavel',
      'responsaveis', 'prazo', 'exato', 'agora', 'hoje', 'amanha', 'garantir', 'proximo',
      'passo', 'quem', 'sera', 'para', 'com', 'que', 'como', 'uma', 'isso', 'essa', 'esse',
    ]);
    return new Set(this._normalizeSignature(value).split(/\s+/).filter((token) => token.length > 2 && !generic.has(token)));
  }

  _semanticSimilarity(left, right) {
    const a = this._semanticTokens(left);
    const b = this._semanticTokens(right);
    if (!a.size || !b.size) return this._normalizeSignature(left) === this._normalizeSignature(right) ? 1 : 0;
    const intersection = [...a].filter((token) => b.has(token)).length;
    return intersection / Math.min(a.size, b.size);
  }

  _isRepeatedIntervention(proposal, currentTime) {
    this.interventionHistory = this.interventionHistory.filter((item) => (
      !this.semanticDedupeMs || currentTime - item.at <= this.semanticDedupeMs
    ));
    return this.interventionHistory.some((item) => this._semanticSimilarity(proposal, item.proposal) >= 0.5);
  }

  _hasLiveCard() {
    const currentTime = this.now();
    if (this.active && this.active.expiresAt != null && this.active.expiresAt <= currentTime) {
      this.active = null;
    }
    this.pendingQueue = this.pendingQueue.filter(
      (item) => item.expiresAt == null || item.expiresAt > currentTime,
    );
    return Boolean(this.active || this.pendingQueue.length);
  }

  _enqueuePlaybookIntervention(intervention) {
    if (!intervention || typeof intervention !== 'object') return false;

    const normalized = validateIntervention(intervention, { now: this.now(), minConfidence: 0.78 });
    if (!normalized) return false;
    const tipo = String(normalized.tipo).toLocaleLowerCase('pt-BR');
    const proposta = normalized.proposta;
    const rationale = normalized.impact;
    const evidence = normalized.evidence;
    const act = normalized.act;
    const confidence = normalized.confidence;

    const currentTime = this.now();
    if (
      this.lastPlaybookInterventionAt != null
      && currentTime - this.lastPlaybookInterventionAt < this.cooldownMs
    ) return false;
    if (this._hasLiveCard()) return false;

    const signature = this._normalizeSignature(proposta);
    if (!signature || this.playbookSignatures.has(signature) || this._isRepeatedIntervention(proposta, currentTime)) return false;

    const item = {
      id: nextId++,
      ordem: null,
      proposta,
      skill: null,
      argumento: null,
      depende_de: null,
      urgencia: tipo === 'alerta' ? 'alerta' : 'copilot',
      category: tipo,
      source: 'playbook',
      rationale,
      act,
      evidence,
      confidence,
      // A validade é uma política da sessão; o validador apenas rejeita cards ruins.
      expiresAt: currentTime + this.ttlMs,
    };
    this.pendingQueue.push(item);
    this.lastPlaybookInterventionAt = currentTime;
    this.lastPlaybookIntervention = proposta;
    this.playbookSignatures.add(signature);
    this.interventionHistory.push({ proposal: proposta, at: currentTime });
    return true;
  }

  emitNext() {
    const currentTime = this.now();
    if (this.active && this.active.expiresAt != null && this.active.expiresAt <= currentTime) {
      this.active = null;
    }
    while (
      this.pendingQueue.length
      && this.pendingQueue[0].expiresAt != null
      && this.pendingQueue[0].expiresAt <= currentTime
    ) {
      this.pendingQueue.shift();
    }
    if (this.active || !this.pendingQueue.length) return;
    this.active = this.pendingQueue.shift();
    this.emit('suggestion', this.active);
  }

  enqueueCoaching(proposta, {
    category = 'coach',
    source = 'coach',
    rationale = null,
    act = null,
    evidence = null,
    confidence = null,
    expiresAt = null,
    ...metadata
  } = {}) {
    if (!proposta) return;
    const currentTime = this.now();
    if (
      this.playbook
      && this.lastPlaybookInterventionAt != null
      && currentTime - this.lastPlaybookInterventionAt < this.cooldownMs
    ) return;

    const signature = this._normalizeSignature(proposta);
    const queuedCards = [this.active, ...this.pendingQueue].filter(Boolean);
    if (queuedCards.some((item) => this._normalizeSignature(item.proposta) === signature)) return;
    if (this._isRepeatedIntervention(proposta, currentTime)) return;

    this.pendingQueue.push({
      id: nextId++, ordem: null, proposta, skill: null, argumento: null,
      depende_de: null, urgencia: 'coaching', category, source,
      rationale, act, evidence, confidence,
      expiresAt: expiresAt ?? currentTime + this.ttlMs,
      ...metadata,
    });
    if (this.playbook) {
      this.lastPlaybookInterventionAt = currentTime;
      this.lastPlaybookIntervention = proposta;
      if (signature) this.playbookSignatures.add(signature);
      this.interventionHistory.push({ proposal: proposta, at: currentTime });
    }
    this.emitNext();
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
    if (['alerta', 'coaching', 'insight', 'copilot'].includes(action.urgencia)) {
      this.emitNext();
      return null; // cards informativos nunca executam skill
    }
    const resolved = { ...action, argumento: this.resolveArgument(action.argumento) };
    this.approved.set(id, resolved);
    return resolved;
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
    const action = this.approved.get(id);
    if (action) {
      this.executedActions.push({ ...action, output });
      if (action.ordem != null) this.batchOutputs[action.ordem] = output;
      this.approved.delete(id);
    }
    this.emitNext();
  }
}
