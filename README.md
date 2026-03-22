# Router CNC - DXF/STEP 3D Viewer

Aplicacao para importacao de DXF e STEP/STP, visualizacao 3D em WebGL, distribuicao de pecas em chapas CNC e preparacao de corte com foco em desempenho.

## Objetivo do projeto

Permitir um fluxo de trabalho orientado a chapas CNC:

- importar pecas DXF e STEP/STP
- visualizar tudo em 3D com Three.js/WebGL
- criar e editar multiplas chapas
- montar pecas automaticamente na chapa ativa ou em todas
- gerenciar estoque de pecas importadas antes da montagem
- configurar ferramentas, simular corte e exportar arquivos `.NC`

## Novidades recentes

- painel direito de `Pecas importadas` com busca por codigo e filtro por tipo (`.DXF` / `.STEP`)
- cards de pecas com miniatura lazy em WebP e DOM virtualizado em grid
- miniatura DXF com simplificacao adaptativa de contorno
- botao `Mover para chapa` removido da topbar
- botao `Editar corte` na topbar com modal central e arrastavel
- botao `Simular corte` na topbar ao lado de `Editar corte`
- biblioteca de ferramentas com presets, cadastro customizado, edicao e exclusao
- profundidade de corte automatica por espessura da chapa (passadas por faixa de espessura e profundidade final com sobrecorte)
- setas de inicio de corte na chapa ativa para definir a origem visual do sequenciamento
- atalho `F9` para alternar as pecas da chapa ativa em cinza (melhor visualizacao da ferramenta no corte)
- simulacao 3D da ferramenta seguindo o caminho de corte no viewport
- exportacao `.NC` por API local e `Ctrl+S` salvando projeto `.CNC3D`
- topbar simplificada sem os badges antigos de render/cache
- offset Z minimo para DXF na chapa para reduzir z-fighting em angulos/zoom extremos
- correcao de artefato visual em DXF preservando os hard normals da extrusao
- miniaturas com paleta de cores variada por peca
- badge de FPS no viewport para monitorar performance
- proxies instanciados em WebGL2 para pecas de chapas inativas
- sincronizacao da espessura das pecas DXF com a espessura da chapa ativa

## Arquitetura do sistema

### Frontend

- `index.html`: estrutura da interface, topbar, viewport, dock de chapas, dock de estoque e modais
- `styles.css`: tema, layout responsivo e estilos dos cards/modais
- `app.js`: renderizacao Three.js/WebGL, importacao DXF/STEP, estado de chapas/estoque e editor de corte
- `sheet-layout.js`: funcoes puras de layout e encaixe sem colisao
- `dxf-worker.js`: parse DXF em paralelo no browser

### Backend local

- `server.py`: servidor HTTP, APIs de parse e APIs de salvamento local
- `run_server.py`: inicializacao simples do servidor

### Testes

- `tests/*.test.mjs`: regressao de UI, atalhos, layout de chapas, estoque e endpoints locais

## Dependencias necessarias

### Python

- Python 3.12
- `ezdxf==1.4.2` para DXF
- `cadquery` opcional para STEP/STP
- `cupy-cuda12x` opcional para rotinas Python com CUDA

### Node.js

- Node.js 18+ para executar `npm test`

## Instalacao

No PowerShell:

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install cadquery
```

## Execucao

### Servidor completo

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
.\.venv\Scripts\python.exe .\run_server.py
```

Abra:

- `http://127.0.0.1:5173`

### Execucao direta do servidor

```powershell
.\.venv\Scripts\python.exe .\server.py --host 127.0.0.1 --port 5173 --dir .
```

## Como usar

1. Clique em `Importar DXF(s)` ou `Importar STEP(s)`.
2. Os arquivos entram primeiro no painel `Pecas importadas`.
3. Ajuste `Qtd` por item, filtre e pesquise se necessario.
4. Use `Chapa` para montar na chapa ativa ou `Montar chapas` para distribuir em todas.
5. Use `Nova chapa` para criar outra chapa.
6. Clique em uma chapa no painel lateral para ativar.
7. Use `Editar chapa` para ajustar largura, altura, margens e espacamento.
8. Use `Editar corte` para escolher ferramenta e parametros; ajuste `Passadas` e o sistema calcula automaticamente `Prof. final` e a profundidade por passada pela espessura da chapa ativa.
9. Use `Simular corte` na topbar para rodar a simulacao da ferramenta no caminho gerado.
10. Pressione `F9` para alternar as pecas da chapa ativa em cinza durante a simulacao.
11. Use `Ctrl+S` para salvar o projeto atual em `.CNC3D`.
12. Clique em `Enquadrar (Fit)` para centralizar a visualizacao.

## Principais funcoes

- `mountInventoryToSheets` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): monta pecas do estoque na chapa ativa ou em todas
- `findBestNestingCandidateForItem` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): escolhe o melhor encaixe heuristico
- `buildCutPlanForSheet` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): monta o plano de corte sob demanda
- `startCutSimulationForSheet` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): roda a simulacao 3D da ferramenta
- `exportCutPlansToNc` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): exporta arquivos `.NC` por chapa
- `saveProjectFile` em [app.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\app.js): salva o projeto em `.CNC3D`
- `findPlacementOnSheet` em [sheet-layout.js](C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main\sheet-layout.js): encontra uma posicao valida sem colisao

## Testes automatizados

Executar:

```powershell
npm test
```

Cobertura atual:

- normalizacao de configuracao da chapa
- area util e colisao com espacamento
- montagem de estoque
- virtualizacao de cards
- badge de FPS
- atalhos de teclado
- modal `Editar chapa`
- modal `Editar corte`
- endpoints locais de salvamento `.CNC3D` e `.NC`

## Endpoints locais

- `POST /api/parse-dxf`
- `POST /api/parse-step`
- `POST /api/save-project`
- `POST /api/save-text`

Arquivos gerados pelo backend local:

- projetos `.CNC3D` na pasta `runtime`
- arquivos `.NC` na pasta `runtime`

## Licenca

Este projeto esta sob a licenca MIT.

Autor: Paulo Augusto
Ano: 2026
