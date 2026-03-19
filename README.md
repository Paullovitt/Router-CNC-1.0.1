# DXFs 3D

Visualizador 3D para DXF e STEP/STP.

## Objetivo do projeto

Renderizar pecas CAD em 3D no navegador com foco em performance visual:

- `Three.js` para renderizacao WebGL (GPU).
- parser DXF em JavaScript para leitura/conversao do arquivo.
- sem cache persistente de pecas no frontend.

## Arquitetura do sistema

### Frontend

- `index.html`: estrutura da interface.
- `styles.css`: estilos da UI.
- `app.js`: pipeline de importacao e renderizacao.
- `dxf-worker.js`: parse DXF em worker para nao travar a thread principal.

Fluxo DXF:

1. Leitura do arquivo no browser.
2. Parse/conversao para contornos.
3. Geracao de malha 3D.
4. Renderizacao via WebGL.

### Backend local (Python)

- `run_server.py` / `server.py`: servidor HTTP local e endpoint STEP.
- `POST /api/parse-step`: converte STEP/STP para STL para exibicao no frontend.

## Dependencias necessarias

### Python

- Python 3.12 (recomendado)
- `ezdxf==1.4.2` (requirements.txt)

### Opcionais

- `cadquery` para importacao STEP/STP.

### Frontend (CDN)

- `three@0.160.0`
- `dxf-parser@1.1.2`

## Instalacao

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Execucao

```powershell
cd C:\Users\USER\Downloads\Ver_DXF\dxf-3d-viewer-main
.\.venv\Scripts\Activate.ps1
python run_server.py
```

Abra:

- `http://127.0.0.1:5173`

## Exemplo de uso

1. Clique em `Importar DXF(s)` e selecione um ou mais arquivos.
2. Ajuste `Espessura (Z)` se necessario.
3. Use `Escala da cena` para escalar o conjunto inteiro.
4. Use `Zoom da camera` para aproximar/afastar sem recriar a geometria.
5. Clique em `Enquadrar (Fit)` para recentralizar a visao.

## Principais modulos/funcoes

- `importSingleFileBrowserPipeline(...)`: importa DXF no navegador (sem cache de pecas).
- `addDxfToScene(...)`: converte os contornos em malha Three.js.
- `applySceneScale(...)`: escala o container de pecas via transformacao.
- `applyCameraZoom(...)`: ajusta zoom da camera via matriz/projecao.
- `fitToScene(...)`: enquadra o volume total das pecas na camera.

## Estrutura de diretorios

```text
dxf-3d-viewer-main/
  app.js
  dxf-worker.js
  index.html
  styles.css
  server.py
  run_server.py
  requirements.txt
  README.md
```
