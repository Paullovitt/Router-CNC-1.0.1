import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("layout possui painel direito de estoque com busca, filtro e botoes de montagem", () => {
  const html = readProjectFile("index.html");
  assert.match(html, /id="inventoryDock"/);
  assert.match(html, /id="inventorySearch"/);
  assert.match(html, /id="inventoryTypeFilter"/);
  assert.match(html, /id="mountActiveSheetBtn"/);
  assert.match(html, /id="mountAllSheetsBtn"/);
});

test("estoque soma duplicadas por codigo e tipo", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function buildInventoryMergeKey\(type, code\)/);
  assert.match(appJs, /const existing = inventoryItems\.find\(\(entry\) => entry\?\.mergeKey === key\);/);
  assert.match(appJs, /existing\.quantity = Math\.max\(0, Number\(existing\.quantity \|\| 0\)\) \+ Math\.max\(0, Number\(payload\?\.quantity \|\| 0\)\);/);
});

test("quantidade no card confirma com Enter e 0 remove item", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function applyInventoryQuantity\(itemId, quantityValue\)/);
  assert.match(appJs, /if \(normalized <= 0\) \{\s*const item = inventoryItems\[idx\];\s*disposeInventoryTemplateGroup\(item\);\s*inventoryItems\.splice\(idx, 1\);/);
  assert.match(appJs, /if \(event\.key !== "Enter"\) return;/);
  assert.match(appJs, /applyInventoryQuantity\(itemId, Number\(target\.value\)\);/);
});

test("botoes Chapa e Montar chapas montam sob demanda com strictPlacement", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /async function mountInventoryToSheets\(\{ acrossAllSheets = false \} = \{\}\)/);
  assert.match(appJs, /strictPlacement: true/);
  assert.match(appJs, /if \(mountActiveSheetBtn\)\s*\{\s*mountActiveSheetBtn\.addEventListener\("click", async \(\) => \{\s*await mountInventoryToSheets\(\{ acrossAllSheets: false \}\);/);
  assert.match(appJs, /if \(mountAllSheetsBtn\)\s*\{\s*mountAllSheetsBtn\.addEventListener\("click", async \(\) => \{\s*await mountInventoryToSheets\(\{ acrossAllSheets: true \}\);/);
});

test("card usa thumbnail lazy com preview em WebP e label de quantidade simplificado", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /class="inventory-thumb"/);
  assert.match(appJs, /loading="lazy"/);
  assert.match(appJs, /decoding="async"/);
  assert.match(appJs, /<span class="inventory-qty-label">Qtd:<\/span>/);
  assert.match(appJs, /toDataURL\("image\/webp", 0\.74\)/);
  assert.match(appJs, /observeInventoryPreviewImages\(\);/);
});

test("miniatura usa paleta de cor por peca com hash deterministico", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function hashStringFast\(text\)/);
  assert.match(appJs, /function buildInventoryPreviewColorProfile\(mergeKey\)/);
  assert.match(appJs, /function computeInventoryPreviewPalette\(item\)/);
  assert.match(appJs, /const previewColor = buildInventoryPreviewColorProfile\(key\);/);
  assert.match(appJs, /previewColor/);
  assert.match(appJs, /const palette = computeInventoryPreviewPalette\(item\);/);
  assert.match(appJs, /drawDxfContourPreview\(ctx, item, width, height, palette\)/);
});

test("preview DXF do card usa simplificacao adaptativa sem stride fixo", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function simplifyPolylineRdp\(points, epsilon\)/);
  assert.match(appJs, /function simplifyPreviewContourPoints\(pointsRaw, maxPoints = 1400\)/);
  assert.match(appJs, /const points = simplifyPreviewContourPoints\(pointsRaw, 1400\);/);
  assert.doesNotMatch(appJs, /Math\.ceil\(pointsRaw\.length \/ 320\)/);
});

test("montagem reutiliza template em memoria e clona grupo para reduzir custo por peÃ§a", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /if \(item\.templateGroup && item\.templateGroup\.isObject3D\)/);
  assert.match(appJs, /const fromSnapshot = buildGroupFromMeshSnapshot\(item\.templateSnapshot, item\.fileName \|\| ""\);/);
  assert.match(appJs, /item\.templateGroup = templateGroup;/);
  assert.match(appJs, /const group = item\.templateGroup\?\.clone\(true\) \|\| null;/);
});

test("estoque usa virtualizacao real de grid no scroll", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /const INVENTORY_CARD_HEIGHT = 196;/);
  assert.match(appJs, /const INVENTORY_VIRTUAL_OVERSCAN_ROWS = 3;/);
  assert.match(appJs, /function ensureInventoryVirtualStructure\(\)/);
  assert.match(appJs, /function renderInventoryVirtualWindow\(force = false\)/);
  assert.match(appJs, /function scheduleInventoryVirtualRender\(force = false\)/);
  assert.match(appJs, /requestAnimationFrame\(\(\) => \{/);
  assert.match(appJs, /inventoryListEl\.addEventListener\("scroll", \(\) => \{/);
  assert.match(appJs, /scheduleInventoryVirtualRender\(\);/);
});

test("painel de estoque usa scroll vertical interno", () => {
  const css = readProjectFile("styles.css");
  assert.match(css, /\.inventory-grid \{[\s\S]*flex: 1 1 auto;/);
  assert.match(css, /\.inventory-grid \{[\s\S]*overflow-y: auto;/);
  assert.match(css, /\.inventory-grid \{[\s\S]*overflow-x: hidden;/);
  assert.match(css, /\.inventory-grid \{[\s\S]*position: relative;/);
  assert.match(css, /\.inventory-grid-content \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.inventory-grid-content \{[\s\S]*grid-auto-rows: 196px;/);
  assert.match(css, /\.inventory-card \{[\s\S]*min-height: 196px;/);
  assert.doesNotMatch(css, /content-visibility:\s*auto/);
  assert.doesNotMatch(css, /contain-intrinsic-size:/);
});
