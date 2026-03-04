# 004 — Correção do fluxo waitreply das campanhas interativas

**Data:** 2026-03-04
**Status:** aceito

## Contexto

Quando um contato respondia a uma campanha interativa no nó `waitreply`, a próxima etapa do fluxo não era executada. A análise dos logs revelou que nenhum webhook da Evolution API chegava ao backend (ausência total de logs `[WEBHOOK-ROUTER]` e `[WEBHOOK-INCOMING]`). Foram identificados múltiplos problemas estruturais no código.

### Problemas identificados

1. **APP_URL hardcoded** — URL do webhook construída com fallback hardcoded para `https://work.trecofantastico.com.br`, sem configuração centralizada.
2. **`interactiveCampaignEnabled` nunca ativado** — O dispatch configurava o webhook mas nunca ativava o flag na sessão.
3. **`connectionId` null na campanha** — O trigger referenciava um ID de `WhatsAppSession`, não de `Connection`, resultando em connectionId null.
4. **Sessões duplicadas por telefone** — Múltiplas sessões ACTIVE para o mesmo telefone, com `findFirst` retornando qualquer uma.
5. **`contains` no match de telefone** — Poderia gerar falsos positivos.

## Decisão

### 1. Campo `appUrl` no GlobalSettings + helper `getAppBaseUrl()`
- Adicionado `appUrl String @default("") @map("app_url")` ao model `GlobalSettings` no Prisma.
- Criado método `getAppBaseUrl()` no `settingsService` com prioridade: `settings.appUrl` > `process.env.APP_URL` > `'http://localhost:3001'`.
- Substituído hardcoded `process.env.APP_URL || 'https://work.trecofantastico.com.br'` por `settingsService.getAppBaseUrl()` em: `interactiveCampaignDispatchService`, `waha.ts` (5 ocorrências), `connectionService`.

### 2. Ativação do `interactiveCampaignEnabled`
- No dispatch service, após configurar o webhook Evolution, ativa-se `interactiveCampaignEnabled: true` na sessão.
- No webhook handler (`incomingWebhookRoutes`), caso receba um webhook com o flag desativado, ativa automaticamente em vez de apenas logar warning.

### 3. Fallback de conexão robusto no flow engine
- Melhorado logging no `sendNodeMessage` para indicar claramente qual caminho de busca de conexão foi usado.
- Adicionado fallback para credenciais Evolution globais quando `_sessionConfig` não fornece credenciais.

### 4. Match de telefone exato + priorização waitreply
- Trocado `contains` por match exato na busca de sessões por telefone.
- Quando múltiplas sessões são encontradas, prioriza-se a que está no nó `waitreply`.

## Alternativas Consideradas

- **Criar registro na tabela Connection para cada WhatsAppSession**: rejeitado por exigir migração de dados complexa e quebrar a compatibilidade com sessões existentes.
- **Remover fallback e exigir connectionId válido**: rejeitado porque o trigger referencia IDs de WhatsAppSession, e migrar todos os grafos existentes seria arriscado.

## Consequências

- **Positivo**: Webhook URL configurável via settings, flag ativado automaticamente, match de telefone sem falsos positivos.
- **Positivo**: Logging detalhado facilita debug de problemas futuros.
- **Negativo**: Requer `prisma db push` ou migration para adicionar campo `app_url` ao banco.
- **Atenção**: A URL base precisa ser configurada via settings ou env `APP_URL` para ambientes de produção.
