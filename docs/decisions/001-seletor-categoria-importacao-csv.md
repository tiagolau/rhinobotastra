# 001 — Seletor de Categoria no Modal de Importação CSV

**Data:** 2026-03-02
**Status:** aceito

## Contexto
Ao importar contatos via CSV, o usuário precisava associar categorias manualmente depois da importação. Isso adicionava um passo extra desnecessário no fluxo de trabalho.

## Decisão
Adicionado um dropdown de categoria opcional diretamente no modal de importação CSV. A categoria selecionada é aplicada a todos os contatos importados, com prioridade sobre qualquer `categoriaId` presente no CSV.

### Arquivos modificados
- `frontend/src/components/CSVImportModal.tsx` — estado, useEffect para carregar categorias, dropdown de seleção
- `frontend/src/services/api.ts` — `importCSV()` agora aceita `categoryId` opcional no FormData
- `backend/src/controllers/csvImportController.ts` — extrai `categoryId` do `req.body`
- `backend/src/services/csvImportService.ts` — valida categoria global uma vez antes do loop, aplica a todos os contatos

### Fluxo
1. Modal abre → carrega categorias via `getAllCategories()`
2. Usuário seleciona arquivo + opcionalmente escolhe categoria
3. FormData enviado com `csv` + `categoryId`
4. Backend valida categoria uma vez → aplica a todos os contatos

## Alternativas Consideradas
- **Coluna no CSV**: já existia suporte a `categoriaId` no CSV, mas exige que o usuário saiba o ID da categoria — pouco prático
- **Atribuição em lote pós-importação**: funciona mas adiciona passo extra ao fluxo

## Consequências
- Fluxo de importação mais direto — categoria atribuída no momento da importação
- Categoria global tem prioridade sobre a do CSV (se ambas existirem)
- Sem categoria selecionada, comportamento anterior é mantido (fallback para CSV ou nenhuma)
