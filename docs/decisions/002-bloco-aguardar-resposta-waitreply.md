# 002 — Bloco "Aguardar Resposta" (waitreply)

**Data:** 2026-03-03
**Status:** aceito

## Contexto
O fluxo de campanhas interativas auto-propagava mensagens em sequência (texto → texto → texto) e só parava em nós `condition` ou `stop`. Para "esperar o lead responder" sem avaliar condições, era necessário usar um nó `condition` de forma improvisada. Os usuários precisavam de um bloco mais simples que pausasse o fluxo e aguardasse qualquer resposta.

## Decisão
Implementado um novo tipo de nó `waitreply` que pausa o fluxo e aguarda qualquer mensagem do lead antes de continuar.

### Frontend
- Criado `WaitReplyNode.tsx` seguindo o padrão do `DelayNode.tsx` (ícone ⏳, cor #f59e0b)
- Registrado em `FlowBuilderPage.tsx` (NODE_TYPES_CONFIG + nodeTypes)
- Adicionado painel de configuração em `NodeConfigSidebar.tsx` com:
  - Banner explicativo
  - Campo opcional "Salvar resposta em variável" (permite usar `{variavel}` em nós seguintes)
  - Campo opcional de timeout (horas/dias) — informativo por ora

### Backend
- `interactiveCampaignDispatchService.ts`: adicionado `waitreply` à lista de nós que param a auto-propagação (`sendSubsequentNodes`)
- `interactiveCampaignFlowEngine.ts`:
  - `continueFlowAfterMessage`: adicionado `waitreply` à lista de nós que param a auto-propagação
  - `processIncomingMessage`: quando o nó atual é `waitreply`, salva a resposta na variável configurada e continua o fluxo chamando `continueFlowAfterMessage` após enviar a próxima mensagem

### Sem alteração no banco
O config fica no JSON do `graph` e a variável de resposta no campo `variables` da sessão (ambos já são JSON). Nenhuma migration necessária.

## Alternativas Consideradas
- **Reutilizar nó `condition` sem regras**: confuso para o usuário, pois `condition` implica avaliação de regras
- **Criar lógica de timeout no backend**: adiado — o campo de timeout existe no config mas não é enforçado ainda, para manter a implementação simples

## Consequências
- Fluxos podem agora pausar e aguardar qualquer resposta sem avaliar condições
- Variáveis salvas ficam disponíveis para interpolação em nós seguintes via `{variavel}`
- Após receber resposta, o fluxo continua auto-propagando até o próximo ponto de parada (condition, stop, waitreply)
- O timeout é apenas informativo na UI — enforcement pode ser adicionado futuramente
