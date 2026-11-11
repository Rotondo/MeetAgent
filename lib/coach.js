import { EventEmitter } from 'node:events';
import { parseJsonLoose } from './claude-client.js';
import config from './config.js';
import { HIGH_PERFORMANCE_GUIDANCE } from './high-performance.js';

const COACH_PROMPT = `Você é um coach executivo discreto durante uma reunião em português.
Devolva UMA intervenção prática para o usuário somente se ela mudar sua próxima ação.

FALAS RECENTES DO USUÁRIO:
{personal}

CONTEXTO RECENTE DA REUNIÃO:
{context}

ROTEIRO DO PROJETO:
{playbook}

CRITÉRIO TRANSVERSAL:
{guidance}

SINAL LOCAL:
{paceSignal}

Responda APENAS JSON válido:
{
  "coaching": "<uma frase pronta de no máximo 120 caracteres ou null>",
  "categoria": "ritmo | escuta | tom | pergunta_pendente | pergunta | proximo_passo | nenhum",
  "ato": "<ato do roteiro ou null>",
  "motivo": "<por que isso importa agora, até 160 caracteres ou null>",
  "evidencia": "<trecho ou fato concreto que sustenta a intervenção, até 160 caracteres ou null>",
  "confidence": "<número de 0 a 1>"
}

Regras:
- Só fale se for acionável agora; não elogie nem resuma.
- O texto de "coaching" deve ter no máximo 120 caracteres, uma frase, sem introdução, sem emoji e sem repetir o contexto.
- Nunca mostre contagem de palavras, palavras por minuto, duração ou qualquer outra métrica.
- "ritmo": use apenas quando o sinal local disser "acelerado".
- "escuta": use apenas se Usuário respondeu sem antes explorar uma pergunta/objeção clara.
- "pergunta_pendente": use apenas se há pergunta concreta ainda sem resposta.
- "pergunta": se Usuário fizer uma pergunta vaga, longa ou sem objetivo, entregue uma reformulação pronta para falar. Use o formato: "Troque por: ‘<pergunta pronta>’". Nunca diga apenas para formular melhor.
- "tom": descreva o tom de forma neutra e proponha um ajuste curto.
- Priorize lacunas do roteiro: ICP, modelo comercial, evidência da integração, responsáveis, prazos e critérios de aceite.
- Não repita uma pergunta que já foi feita ou uma decisão já confirmada.
- Se não houver evidência + motivo concreto, devolva coaching null, categoria "nenhum" e confidence 0.
- Não invente falas, pessoas, perguntas ou números.
- Nunca proponha executar skills neste fluxo.
- Responda em português.`;

function words(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function trimSegments(segments, cutoff) {
  return segments.filter((segment) => segment.at >= cutoff);
}

function clampFeedback(text, maxLength = 120) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export class Coach extends EventEmitter {
  constructor({
    runFn,
    model = 'haiku',
    intervalMs = config.coachIntervalMs,
    timeoutMs = config.coachTimeoutMs,
    cooldownMs = config.coachCooldownMs,
    paceCooldownMs = config.paceCooldownMs,
    contextMs = config.coachContextMs,
    paceWindowMs = config.coachPaceWindowMs,
    fastWpm = config.coachFastWpm,
    minWords = config.coachMinWords,
    minDurationSeconds = config.coachMinDurationSeconds,
    feedbackTtlMs = config.coachFeedbackTtlMs,
    minFeedbackGapMs = config.coachMinFeedbackGapMs,
    playbook = '',
    guidance = HIGH_PERFORMANCE_GUIDANCE,
    now = () => Date.now(),
  }) {
    super();
    this.runFn = runFn;
    this.model = model;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.paceCooldownMs = paceCooldownMs;
    this.contextMs = contextMs;
    this.paceWindowMs = paceWindowMs;
    this.fastWpm = fastWpm;
    this.minWords = minWords;
    this.minDurationSeconds = minDurationSeconds;
    this.feedbackTtlMs = feedbackTtlMs;
    this.minFeedbackGapMs = minFeedbackGapMs;
    this.playbook = String(playbook ?? '').slice(0, 8_000);
    this.guidance = String(guidance ?? '').slice(0, 3_000);
    this.now = now;
    this.personal = [];
    this.context = [];
    this.lastReviewAt = 0;
    this.lastCategoryAt = new Map();
    this.lastFeedbackAt = 0;
    this.reviewBlockedUntil = 0;
    this.timer = null;
    this.processing = false;
  }

  setPlaybook(playbook) {
    this.playbook = String(playbook ?? '').slice(0, 8_000);
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.review(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  suppressFor(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.reviewBlockedUntil = Math.max(this.reviewBlockedUntil, this.now() + duration);
  }

  addPersonal({ text, at = this.now(), duration = 0 }) {
    if (!text) return;
    this.personal.push({ text, at, duration: Number(duration) || 0 });
    this._trim();
    this._checkPace();
  }

  addContext({ text, at = this.now() }) {
    if (!text) return;
    this.context.push({ text, at });
    this._trim();
  }

  _trim() {
    const cutoff = this.now() - this.contextMs;
    this.personal = trimSegments(this.personal, cutoff);
    this.context = trimSegments(this.context, cutoff);
  }

  metrics() {
    const cutoff = this.now() - this.paceWindowMs;
    const recent = this.personal.filter((segment) => segment.at >= cutoff);
    const wordCount = recent.reduce((total, segment) => total + words(segment.text), 0);
    const durationSeconds = recent.reduce((total, segment) => total + segment.duration, 0);
    const wpm = durationSeconds > 0 ? Math.round((wordCount * 60) / durationSeconds) : 0;
    return { wordCount, durationSeconds, wpm };
  }

  _canEmit(category, cooldown) {
    if (!this.lastCategoryAt.has(category)) return true;
    return this.now() - this.lastCategoryAt.get(category) >= cooldown;
  }

  _emitFeedback({
    text,
    category,
    source,
    rationale = '',
    act = null,
    evidence = '',
    confidence = null,
  }) {
    const shortText = clampFeedback(text);
    if (!shortText || category === 'nenhum') return false;
    if (this.now() < this.reviewBlockedUntil) return false;
    if (this.lastFeedbackAt && this.now() - this.lastFeedbackAt < this.minFeedbackGapMs) return false;
    const cooldown = category === 'ritmo' ? this.paceCooldownMs : this.cooldownMs;
    if (!this._canEmit(category, cooldown)) return false;
    this.lastCategoryAt.set(category, this.now());
    this.lastFeedbackAt = this.now();
    this.emit('feedback', {
      text: shortText,
      category,
      source,
      rationale: clampFeedback(rationale, 160),
      act: act ? clampFeedback(act, 80) : null,
      evidence: clampFeedback(evidence, 160),
      confidence,
      at: this.now(),
    });
    return true;
  }

  _checkPace() {
    const metric = this.metrics();
    if (metric.wordCount < this.minWords || metric.durationSeconds < this.minDurationSeconds || metric.wpm < this.fastWpm) return;
    this._emitFeedback({
      category: 'ritmo',
      source: 'métrica-local',
      text: 'Reduza um pouco o ritmo e faça uma pausa antes do próximo ponto.',
      rationale: 'O ritmo acelerado se manteve por tempo suficiente para prejudicar a compreensão.',
      evidence: 'Sinal local de ritmo acelerado sustentado.',
      confidence: 1,
    });
  }

  buildPrompt() {
    const personal = this.personal.map((segment) => segment.text).join(' ') || '(sem fala pessoal recente)';
    const context = this.context.map((segment) => segment.text).join(' ') || '(sem contexto recente)';
    const metric = this.metrics();
    const paceSignal = (
      metric.wordCount >= this.minWords
      && metric.durationSeconds >= this.minDurationSeconds
      && metric.wpm >= this.fastWpm
    ) ? 'ritmo acelerado sustentado: sim' : 'ritmo acelerado sustentado: não';
    const coolingCategories = [...this.lastCategoryAt.entries()]
      .filter(([category, at]) => this.now() - at < (category === 'ritmo' ? this.paceCooldownMs : this.cooldownMs))
      .map(([category]) => category)
      .join(', ') || 'nenhuma';
    return COACH_PROMPT
      .replace('{personal}', personal)
      .replace('{context}', context)
      .replace('{playbook}', this.playbook || '(sem roteiro específico)')
      .replace('{guidance}', this.guidance || '(sem orientação transversal)')
      .replace('{paceSignal}', `${paceSignal}. Categorias em cooldown: ${coolingCategories}.`);
  }

  async review() {
    if (this.processing || !this.runFn) {
      this.emit('review', { status: 'skip', reason: this.processing ? 'processando' : 'sem-runner' });
      return;
    }
    if (this.now() < this.reviewBlockedUntil) {
      this.emit('review', { status: 'skip', reason: 'intervencao-recente' });
      return;
    }
    if (this.lastFeedbackAt && this.now() - this.lastFeedbackAt < this.minFeedbackGapMs) {
      this.emit('review', { status: 'skip', reason: 'cooldown-global' });
      return;
    }
    const newPersonal = this.personal.filter((segment) => segment.at > this.lastReviewAt);
    const newWordCount = newPersonal.reduce((total, segment) => total + words(segment.text), 0);
    if (newWordCount < 12) {
      this.emit('review', { status: 'skip', reason: 'fala-insuficiente', words: newWordCount });
      return;
    }
    this.processing = true;
    const reviewStartedAt = this.now();
    let reviewConsumed = false;
    this.emit('review', { status: 'started', words: newWordCount });
    try {
      const raw = await this.runFn(this.buildPrompt(), { model: this.model, timeoutMs: this.timeoutMs, purpose: 'coach' });
      reviewConsumed = true;
      if (this.now() - reviewStartedAt > this.feedbackTtlMs) {
        this.emit('review', { status: 'skip', reason: 'feedback-expirado' });
        return;
      }
      const parsed = parseJsonLoose(raw);
      const confidence = Number(parsed?.confidence);
      if (
        parsed?.coaching
        && typeof parsed.coaching === 'string'
        && typeof parsed.motivo === 'string'
        && parsed.motivo.trim()
        && typeof parsed.evidencia === 'string'
        && parsed.evidencia.trim()
        && Number.isFinite(confidence)
        && confidence >= 0.72
      ) {
        const delayed = this.now() - reviewStartedAt > this.intervalMs;
        const emitted = this._emitFeedback({
          text: parsed.coaching,
          category: parsed.categoria ?? 'tom',
          source: delayed ? 'coach-em-fila' : 'coach',
          rationale: parsed.motivo,
          act: parsed.ato,
          evidence: parsed.evidencia,
          confidence,
        });
        this.emit('review', { status: emitted ? 'feedback' : 'skip', reason: emitted ? null : 'cooldown', category: parsed.categoria ?? 'tom' });
      } else {
        this.emit('review', {
          status: 'skip',
          reason: parsed?.coaching ? 'baixa-confianca' : 'sem-feedback',
        });
      }
    } catch (err) {
      this.emit('review', { status: 'error', message: err.message });
      this.emit('status', `coach indisponível: ${err.message}`);
    } finally {
      // Em falha transitória, mantém a fala na fila para a próxima rodada.
      if (reviewConsumed) this.lastReviewAt = reviewStartedAt;
      this.processing = false;
    }
  }
}
