# Meeting Agent

Coach discreto e assistente executivo para reuniões no Windows. O aplicativo captura a conversa, transcreve em tempo real, entrega devolutivas curtas sobre a condução, sugere perguntas com contexto e gera um encerramento revisável.

## Proposta do aplicativo

O Meeting Agent foi desenhado para ajudar durante a reunião sem virar outra reunião para administrar:

- captura o áudio do interlocutor e do microfone;
- detecta ritmo acelerado localmente, mas nunca exibe contagem de palavras ou WPM;
- exibe uma microintervenção por vez, com ato, frase pronta, evidência e cooldown;
- monta uma pergunta pronta e explica por que ela é pertinente quando você solicita;
- mantém insights e propostas de skills automáticos desligados por padrão para economizar tokens;
- usa em todas as agendas uma lente silenciosa de resultado, escuta, clareza, alinhamento e compromisso;
- gera sumário, avaliação do roteiro, próximos passos, CRM, tokens e custo estimado ao encerrar;
- se todas as IAs falharem, encerra mesmo assim e preserva a transcrição em um relatório parcial.

## Fluxo de dados e privacidade

| Dado | Destino | Finalidade |
| --- | --- | --- |
| Áudio selecionado | Deepgram | Transcrição em tempo real |
| Trechos de transcrição | Codex pela conta ChatGPT | Coach, pergunta, insights opcionais e encerramento |
| Skill aprovada | Claude Code CLI e recursos declarados pela própria skill | Executar a ação escolhida |
| Configuração, logs e relatórios | `%LOCALAPPDATA%\MeetingAgent` | Persistência local |

O aplicativo não envia áudio ao GitHub. Uma skill pode acessar serviços externos se ela tiver sido criada para isso; por essa razão, skills só executam após aprovação e passam por uma lista de permissões do projeto.

A chave da Deepgram e as integrações opcionais são protegidas pelo armazenamento seguro do Electron/Windows. A análise usa o login OAuth gerenciado pelo Codex, sem chave OpenAI ou Gemini. Logs e relatórios não ficam dentro do repositório do código.

Não use o aplicativo sem observar as regras de consentimento, privacidade e gravação aplicáveis à reunião.

## Pré-requisitos

- Windows 10 ou 11;
- Node.js 20 ou superior;
- API Key da Deepgram;
- Codex CLI instalado e uma conta ChatGPT com acesso ao Codex;
- Claude Code CLI autenticado somente se você quiser executar skills;
- fone de ouvido recomendado para reduzir eco.

## Instalação

No PowerShell:

```powershell
cd "C:\caminho\para\meeting-agent"
npm install
npm test
npm start
```

Depois da instalação, também é possível abrir pelo arquivo `Iniciar Reunião.ps1`.

## Configuração inicial

1. Abra `⚙ Configurações`.
2. Salve a chave da Deepgram.
3. Em `IA pelo ChatGPT`, clique em `Entrar com ChatGPT` e conclua o OAuth no navegador.
4. Em `Contextos`, crie ou escolha um contexto e um direcional ativo.
5. Habilite somente as skills confiáveis encontradas em `.claude/skills/<nome>/SKILL.md` no contexto aplicável.
6. Escolha a fonte de áudio:
   - `Sistema + microfone`: reunião completa e coach pessoal;
   - `Somente sistema`: interlocutores, sem análise pessoal confiável;
   - `Somente microfone`: apenas sua fala.
7. Escolha a frequência do coach: 15, 25 ou 40 segundos.

No modo `Sistema + microfone`, o app mantém uma transcrição completa da reunião e outra dedicada ao microfone. Isso preserva a fala do interlocutor e permite diferenciar a sua condução, mas consome duas trilhas de transcrição.

`Insights automáticos` fica desligado por padrão. Quando ativado, o app também pode produzir alertas, insights e propostas de skills em janelas da conversa, com consumo adicional.

## Contextos e direcionais

A preparação da agenda segue quatro escolhas obrigatórias: **Contexto → Direcional → Público → Objetivo**. Isso separa o conhecimento duradouro do roteiro de condução da conversa.

- **Contexto**: área de atuação e conhecimento persistente, como Liderança, Parcerias ou Produto;
- **Direcional**: roteiro dentro do contexto, como 1:1, negociação, descoberta ou apresentação;
- **Público**: interna, cliente, parceiro, prospect, 1:1 ou mista;
- **Objetivo**: escuta/descoberta, apresentação, alinhamento, decisão, execução, feedback ou 1:1.

Os antigos projetos são migrados automaticamente: `Liderança` vira o contexto com `Condução geral`; `Apresentação de Soluções` permanece como contexto e direcional. A biblioteca inicial também sugere Parcerias, Produto e Projetos e Cliente e Prospect.

Para criar conteúdo novo, use `Novo contexto` ou `Novo direcional` em `⚙ Configurações > Contextos`:

1. Cole o briefing original.
2. Clique em `Copiar prompt para LLM externo`.
3. Use o Claude, Gemini ou outro LLM fora do app e copie de volta o Pacote de Contexto em Markdown.
4. Valide, salve como rascunho, revise e ative explicitamente.

Esse fluxo de criação não chama uma IA pelo aplicativo. Um pacote inválido não pode ser ativado. Durante reuniões, a análise usa somente a conta ChatGPT/Codex e os modelos disponíveis nela.

Para agendas de escuta, o pacote pode definir `analysis_interval_seconds: 60` ou `90`. Isso reduz a frequência de consultas ao vivo e do coach para priorizar o consumo de tokens; os valores aceitos são `15`, `25`, `40`, `60` e `90`. Sem esse campo, o app mantém a frequência geral escolhida em Preferências.

O pacote usa frontmatter e as seções `Direcional`, `Resultado esperado`, `Atos`, `Perguntas prioritárias`, `Regras e limites` e `Critérios de encerramento`. O conteúdo é combinado com a camada global de Alta Performance, o contexto, direcional, público e objetivo no início da reunião.

Um contexto ainda pode incluir `.meeting-agent/ROTEIRO.md`. Nesse caso, o roteiro legado é incorporado ao copiloto contextual mesmo com `Insights automáticos` desligado. O frontmatter mínimo é:

```markdown
---
profile: nome-do-perfil
live_analysis: true
---
```

O contexto `Apresentação de Soluções` já foi cadastrado e usa a pasta:

```text
C:\caminho\para\seu-projeto
```

## Uso

### Hoje: agenda, continuidade e memória confiável

O painel `Hoje` transforma o aplicativo em secretária de agendas, além do apoio durante a conversa:

- crie uma agenda com iniciativa, objetivo e participantes;
- escolha `silenciosa`, `proteção` ou `coach`; intervenções automáticas só aparecem quando `Piloto` está habilitado;
- consulte o briefing formado apenas por memórias aprovadas da mesma iniciativa;
- ao encerrar, revise o follow-up e aprove, rejeite ou corrija cada registro antes de reutilizá-lo;
- importe relatórios antigos quando contiverem próximo passo e evidência, sempre como memória não revisada.

O motor ao vivo separa observação factual, proposta de fala e crítica independente. Responsável e prazo não são inferidos; um alerta automático precisa de evidência literal, conflito concreto e uma pergunta acionável. Silêncio é um resultado válido.

1. Em `Preparar agenda`, selecione Contexto, Direcional, Público e Objetivo. Confira a prévia da condução.
2. Clique em `Iniciar reunião`.
3. Se usar áudio do sistema, escolha a tela ou fonte que está reproduzindo a reunião.
4. Confirme os indicadores `Sistema`, `Microfone`, `Deepgram`, `Coach` e `IA`.
5. Durante a conversa:
   - leia os cards curtos do coach;
   - clique em `Sugerir pergunta` para receber a pergunta pronta e o motivo;
   - use o campo de chat para uma consulta manual;
   - aprove ou ignore uma ação de skill explicitamente.
6. Clique em `Encerrar` e confirme. O painel fica imediatamente com 100% de opacidade enquanto finaliza.
7. Revise qualquer ação pendente; nenhuma vem pré-selecionada.

O botão de pergunta é sob demanda: ele usa a discussão completa recente mesmo quando você ainda não falou, evitando consumo contínuo de tokens.

## Encerramento, tokens e custo

O relatório contém:

- sumário e tom;
- próximos passos com responsável, prazo, evidência e critério somente quando explícitos;
- avaliação dos atos do roteiro, perguntas abertas, oportunidades e desvios de foco;
- registro para CRM;
- ações pendentes;
- tokens de entrada, saída e total agrupados por provedor, modelo e finalidade;
- uso informado pelo Codex, quando disponível.

Se o Codex ou a conta estiverem indisponíveis, o aplicativo não fica preso: salva um relatório parcial com a transcrição e o ledger, permite fechar normalmente e oferece reprocessamento após a reconexão.

## Agenda, documentos e modelos

Em `Configurações`:

1. entre com o ChatGPT e escolha um perfil de IA ou selecione, no catálogo vivo da conta, o modelo e o esforço de cada função;
2. mantenha `Adaptação automática` ativa para o agente reconhecer apresentação, decisão, execução, discovery e 1:1, além do papel do usuário;
3. para o Google, crie no Google Cloud um cliente OAuth do tipo **Aplicativo para computador**, ative Calendar API e Drive API, cole o Client ID (e o secret, se fornecido) e clique em `Conectar Google`;
4. clique em `Sincronizar agenda` para importar os próximos eventos;
5. opcionalmente, salve a API Key do Fireflies e escolha manualmente qual reunião anterior deve ser usada como contexto;
6. escolha uma pasta local com arquivos `.md`, `.txt`, `.json` ou `.csv` para enriquecer briefings relacionados.

As credenciais Google, o token OAuth e a chave Fireflies são protegidos pelo armazenamento seguro do Windows. O aplicativo solicita somente leitura de Calendar e Drive. A associação de uma iniciativa sugerida e de uma transcrição Fireflies exige confirmação na tela inicial.

Durante a reunião, o cabeçalho mostra o modo e o papel inferidos. Em modo ouvinte, sugestões automáticas são suprimidas, mas anúncios, propostas, decisões e perguntas continuam sendo registrados para o encerramento.

## Arquivos locais

| Conteúdo | Caminho |
| --- | --- |
| Preferências e projetos | `%LOCALAPPDATA%\MeetingAgent\projects.json` |
| Chaves criptografadas | `%LOCALAPPDATA%\MeetingAgent\*.key` |
| Diagnóstico | `%LOCALAPPDATA%\MeetingAgent\logs` |
| Relatórios | `%LOCALAPPDATA%\MeetingAgent\outputs` |

Na primeira abertura desta versão, dados existentes em `%USERPROFILE%\meeting-agent` são copiados para o novo local sem apagar nem sobrescrever os originais.

Os logs não armazenam áudio, chaves, prompts ou o texto integral da reunião. Eles registram ciclo de vida, saúde das fontes, quantidade técnica de palavras, tentativas de provedor, latência, motivos de uma rodada não gerar feedback e o texto exato dos cards efetivamente mostrados. Isso permite auditar a qualidade do copiloto sem guardar a conversa completa.

Em `Configurações > Preferências`, use `Localizar último log`: a pasta abre com o arquivo mais recente selecionado. O arquivo da reunião real auditada nesta revisão é:

```text
%LOCALAPPDATA%\MeetingAgent\logs\session-2026-07-24-09-33-15.jsonl
```

## Copiloto de Apresentação de Soluções

O roteiro dedicado organiza a conversa em:

1. quebra-gelo e contrato da agenda;
2. escuta e qualificação;
3. apresentação do produto;
4. modelo comercial;
5. integração e homologação;
6. exploração estratégica e estacionamento;
7. próximos passos.

Uma intervenção só aparece quando puder mudar os próximos 30–90 segundos. Conselhos genéricos, resumos do último trecho, métricas de fala e repetição de perguntas já respondidas são rejeitados.

A skill reutilizável fica em:

```text
C:\caminho\para\seu-projeto\.claude\skills\conduzir-apresentacao-solucoes
```

## Segurança das skills

- O Claude CLI não participa mais do ciclo automático do coach.
- Ele abre apenas para uma skill aprovada.
- A execução é bloqueada no processo principal se a skill não estiver habilitada no projeto.
- Cards de coaching, insight e alerta nunca executam comandos.
- No encerramento, ações ficam desmarcadas e exigem seleção explícita.

Revise o conteúdo de uma skill antes de habilitá-la.

## Diagnóstico

Se não houver transcrição:

1. confira os indicadores de áudio e Deepgram;
2. tente `Somente microfone` para isolar permissões;
3. tente `Somente sistema` e selecione a fonte novamente;
4. confirme internet e a chave da Deepgram;
5. clique em `Localizar último log` nas Preferências.

Se a IA falhar:

1. confirme o login ChatGPT em `Configurações`;
2. atualize o catálogo de modelos e observe o indicador `IA`;
3. encerre normalmente — a transcrição e o ledger serão preservados;
4. use `Reprocessar análise` quando a conta voltar, ou aguarde o reprocessamento automático.

## Testes

```powershell
npm test
```

A suíte cobre provedores e fallback, circuit breaker, coach, qualidade de intervenção, playbook, rotulagem aproximada de falantes, cooldown/TTL, KeepAlive da Deepgram, migração de dados, segurança das credenciais, encerramento parcial, custo estimado, dispatcher, skills e transcrição.

## Arquitetura

Consulte [docs/superpowers/specs/2026-07-18-meeting-agent-design.md](docs/superpowers/specs/2026-07-18-meeting-agent-design.md).

O diagnóstico completo desta revisão está em [docs/AUDITORIA-2026-07-23.md](docs/AUDITORIA-2026-07-23.md).
