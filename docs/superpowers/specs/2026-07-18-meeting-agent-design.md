# Meeting Agent — arquitetura implementada

**Atualização:** 2026-07-23

## Objetivo

Oferecer coaching discreto, contexto acionável e encerramento confiável durante reuniões, com baixo atrito, consumo controlado e execução segura de skills.

## Fluxo principal

```text
microfone ───────────────┐
                          ├─ mixagem PCM ── Deepgram ── transcript completo ── pergunta/encerramento
sistema ──────────────────┘                         │
                                                   └─ insights automáticos opcionais

microfone ── PCM exclusivo ── Deepgram ── fala do usuário ── métricas locais + coach

coach/pergunta/encerramento ── Codex App Server ── OAuth da conta ChatGPT
skill aprovada ─────────────────────────────── Claude Code CLI
```

## Decisões de produto

- O coach opera automaticamente apenas quando há fala pessoal suficiente.
- A sugestão de pergunta é manual e usa o contexto da discussão, mesmo se o usuário estiver em silêncio.
- Insights, alertas e propostas automáticas de skills ficam desligados por padrão.
- Cards exibem uma orientação por vez e expiram para não ocupar a interface.
- Toda ação externa exige aprovação; cards informativos nunca executam comandos.
- O encerramento é recuperável: se as IAs falharem, a transcrição é salva em relatório parcial.

## Captura e transcrição

- `electron-audio-loopback` captura o som reproduzido pelo sistema.
- `getUserMedia` captura o microfone.
- `AudioWorklet` converte as fontes em PCM mono de 16 kHz.
- No modo combinado, um stream contém a reunião e outro contém somente o microfone.
- A Deepgram recebe `KeepAlive` textual durante silêncio para evitar desconexão após cerca de 10 segundos.
- O transcriber reconecta com backoff em falhas transitórias e finaliza buffers ao encerrar.

## IA e latência

- O catálogo é carregado dinamicamente com `model/list`; não existem IDs de modelo fixos no produto.
- O usuário pode usar o modelo padrão da conta ou configurar modelo e esforço por finalidade.
- Cada solicitação possui prazo global, fatia de tempo por provedor e circuit breaker de cinco minutos.
- O Claude CLI não roda no hot path; isso evita inicializar MCP/Serena repetidamente.
- Uma resposta de coach que chega tarde demais é descartada; em falha transitória, a fala permanece para nova tentativa.
- Feedbacks são limitados a 120 caracteres e têm cooldown por categoria.

## Estado de sessão

```text
inativa → iniciando → ao vivo ↔ degradada → encerrando → relatório
                                      └────→ erro recuperável → encerrando
```

- `degradada`: uma fonte ou serviço foi interrompido, mas a sessão ainda pode ser encerrada.
- `erro recuperável`: um erro inesperado ocorreu no encerramento; o usuário pode tentar novamente.
- Falha somente da IA não entra em erro recuperável: produz relatório parcial e conclui.

## Encerramento

1. Para o coach.
2. Finaliza os transcribers em paralelo.
3. Espera no máximo três segundos pela janela do dispatcher.
4. Tenta gerar relatório em uma thread efêmera do Codex; se falhar, usa o ledger persistido e preserva a transcrição para reprocessamento.
5. Em falha, salva relatório parcial com transcrição.
6. Acrescenta tokens e custo estimado.
7. Exibe ações pendentes desmarcadas.
8. Executa somente as ações selecionadas e permitidas.

## Segurança

- Chaves são criptografadas pelo `safeStorage` do Electron/Windows.
- Dados operacionais ficam fora do repositório.
- O processo principal valida a allowlist de skills antes da execução.
- O renderer recebe uma API IPC restrita pelo preload.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` não é herdado pelo aplicativo.
- Logs removem campos sensíveis e não registram áudio, prompts ou transcrição integral.

## Persistência

```text
%LOCALAPPDATA%\MeetingAgent\projects.json
%LOCALAPPDATA%\MeetingAgent\deepgram.key
%LOCALAPPDATA%\MeetingAgent\openai.key
%LOCALAPPDATA%\MeetingAgent\gemini.key
%LOCALAPPDATA%\MeetingAgent\logs\
%LOCALAPPDATA%\MeetingAgent\outputs\
```

Uma migração idempotente copia dados do caminho legado `%USERPROFILE%\meeting-agent` sem apagar ou sobrescrever.

## Observabilidade

Cada sessão registra:

- início, fase e motivo do encerramento;
- estado das fontes e transcribers;
- quantidade e duração dos trechos;
- início, sucesso, falha, latência, modelo e uso de cada provedor;
- decisões do coach e motivo de skips;
- solicitações manuais e bloqueios de skill.

## Limites conhecidos

- Não há diarização individual; participantes só podem ser inferidos pelo texto.
- A captura de sistema pode incluir notificações e outros sons.
- Duas trilhas Deepgram aumentam o consumo no modo combinado.
- O custo mostrado é estimado; o painel do provedor é definitivo.
- A qualidade depende da fonte escolhida, rede, acústica e precisão da transcrição.

## Verificação

- suíte unitária completa passa;
- sintaxe dos processos principal e renderer é validada;
- fallback e circuit breaker de provedores são testados;
- KeepAlive e reconexão da Deepgram são testados;
- encerramento parcial preserva a transcrição;
- skills fora da allowlist são bloqueadas;
- nenhuma ação de encerramento vem pré-selecionada.
