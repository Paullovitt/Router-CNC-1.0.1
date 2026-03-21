# Router CNC - DXF/STEP 3D Viewer com Layout por Chapas

Aplicacao para importacao de DXF e STEP/STP, visualizacao 3D em WebGL e distribuicao de pecas em chapas CNC com foco em desempenho.

## Objetivo do projeto

Permitir importacao e visualizacao 3D de pecas DXF/STEP com um fluxo de producao orientado a chapas CNC:

- criar multiplas chapas
- selecionar chapa ativa
- posicionar pecas automaticamente dentro da area util da chapa
- mover pecas para outra chapa sem sair dos limites configurados
- gerenciar estoque de pecas importadas antes de montar nas chapas

## Novidades recentes

- painel direito de `Pecas importadas` com busca por codigo e filtro por tipo (`.DXF` / `.STEP`)
- cards de pecas com miniatura lazy em WebP e DOM virtualizado em grid (renderiza so o trecho visivel)
- miniatura DXF com simplificacao adaptativa de contorno (evita distorcao em pecas com muitos pontos)
- topbar simplificada sem os badges separados de total de pecas
- offset Z minimo para DXF na chapa para reduzir z-fighting em angulos/zoom extremos
- correção de artefato visual em DXF: preservacao dos hard normals da extrusao (sem suavizacao indevida), reduzindo manchas/borrado em zoom/angulo e com menor custo de CPU no import
- miniaturas com paleta de cores variada por peca (deterministica), evitando repeticao visual
- campo `Qtd` por item no estoque (Enter confirma, `0` remove o item)
- botoes de montagem:
  - `Chapa`: monta na chapa ativa
  - `Montar chapas`: distribui em todas as chapas
- montagem por nesting heuristico (ordenacao por area, orientacao 0/90, score de aproveitamento e checagem de colisao)
- badge de FPS no viewport para monitorar performance em tempo real
- renderizacao de proxies instanciados (WebGL2) para pecas de chapas inativas
- sincronizacao da espessura das pecas DXF com a espessura da chapa ativa

## Arquitetura do sistema

### Frontend (browser)

- `index.html`: estrutura da tela (toolbar, dock de chapas, viewport 3D, dock de estoque, modal de edicao de chapa)
- `styles.css`: tema e layout responsivo
- `app.js`: renderizacao Three.js/WebGL, importacao DXF browser-only, importacao STEP, selecao/transform, estado de chapas e estoque
- `app.js`: ajuste dinamico de `near/far` da camera para reduzir artefatos de profundidade em zoom distante
- `app.js`: proxies instanciados para chapas inativas (pipeline com shader custom e atributos de instancia)
- `app.js`: miniaturas das pecas com geracao por canvas, cores por item, cache em memoria e virtualizacao real do estoque
- `sheet-layout.js`: funcoes puras de layout (origem de chapas, area util, encaixe sem colisao)
- `dxf-worker.js`: parse DXF em paralelo no browser

### Backend local (Python)

- `server.py`: servidor HTTP para arquivos estaticos e APIs de parse
- `run_server.py`: ponto de entrada simples para subir o servidor

### Testes

- `tests/*.test.mjs`: validacao de layout de chapas, UI de estoque, modal de chapa, badge FPS, atalhos e regressao visual/logica

## Dependencias necessarias

### Python

- Python 3.12 (recomendado)
- `ezdxf==1.4.2` (obrigatorio para DXF)
- `cadquery` (opcional, necessario para STEP/STP)
- `cupy-cuda12x` (opcional, apenas para uso direto no backend Python)

### Node.js (somente para testes)

- Node.js 18+ (usado para `node --test`)

## Instalacao

No PowerShell, dentro da pasta do projeto:

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install cadquery
```

## Execucao

### Servidor completo (DXF + STEP + APIs)

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
.\.venv\Scripts\python.exe .\run_server.py
```

Abra no navegador:

- `http://127.0.0.1:5173`

### Execucao direta do servidor

```powershell
.\.venv\Scripts\python.exe .\server.py --host 127.0.0.1 --port 5173 --dir .
```

## Como usar (exemplo rapido)

1. Clique em `Importar DXF(s)` ou `Importar STEP(s)`.
2. Os arquivos entram primeiro no painel `Pecas importadas`.
3. Ajuste `Qtd` por item, filtre e pesquise se necessario.
4. Use `Chapa` para montar na chapa ativa ou `Montar chapas` para distribuir em todas.
5. Use `Nova chapa` para criar outra chapa.
6. Clique em uma chapa no painel lateral para ativar.
7. As chapas ficam em layout circular no viewport; ao selecionar outra chapa, ocorre transicao para trazer a selecionada ao centro (sem giro continuo).
8. Use `Mover para chapa` para enviar a peca selecionada para a chapa ativa.
9. Use `Editar chapa` para ajustar largura, altura, margens e espacamento.
10. No modal:
   - `Aplicar`: altera somente a chapa ativa.
   - `Aplicar em todas`: altera todas as chapas atuais e vira padrao para novas chapas.
11. Clique em `Enquadrar (Fit)` para centralizar a visualizacao.

## Principais modulos/funcoes

- `assignPartToSheet` (`app.js`): aloca peca em chapa com fallback para nova chapa
- `relayoutSheetPieces` (`app.js`): reorganiza pecas apos alterar parametros da chapa
- `mountInventoryToSheets` (`app.js`): monta pecas do estoque em chapa ativa ou em todas
- `findBestNestingCandidateForItem` (`app.js`): escolhe melhor encaixe por score em cada chapa/orientacao
- `computeInventoryPreviewPalette` (`app.js`): define paleta de miniatura por peca
- `syncInactiveProxyInstancing` (`app.js`): atualiza proxies instanciados para chapas inativas
- `findPlacementOnSheet` (`sheet-layout.js`): calcula primeira posicao valida sem colisao
- `getSheetUsableBounds` (`sheet-layout.js`): calcula area util com margens

## Testes automatizados

Executar:

```powershell
npm test
```

Cobertura atual dos testes:

- normalizacao de configuracao da chapa
- calculo de origem entre chapas
- calculo de area util
- deteccao de colisao com espacamento
- busca de posicao valida para encaixe
- falha esperada quando a peca nao cabe
- painel e fluxo de estoque de pecas
- virtualizacao real do estoque (grid) para manter DOM pequeno mesmo com muitas pecas
- badge de FPS
- atalhos de teclado para remocao
- pipeline de instancing para proxies inativos

## Endpoints locais

- `POST /api/parse-dxf`
- `POST /api/parse-step`

## Licenca

Este projeto esta sob a licenca MIT. Veja o arquivo `LICENSE` para os detalhes completos.

Autor: Paulo Augusto  
Ano: 2026
