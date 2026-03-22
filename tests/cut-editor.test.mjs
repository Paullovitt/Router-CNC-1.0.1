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

test("topbar e html contem editor e simulacao de corte", () => {
  const html = readProjectFile("index.html");
  assert.match(html, /id="editCutBtn"/);
  assert.match(html, /id="editCutBtn"[\s\S]*id="simulateCutBtn"/);
  assert.match(html, /Editar corte/);
  assert.doesNotMatch(html, /id="cutEditModal"[\s\S]*id="simulateCutBtn"/);
  assert.match(html, /id="cutEditModal"/);
  assert.match(html, /id="simCutModal"/);
  assert.match(html, /id="exportNcBtn"/);
  assert.match(html, /id="projectInfo"/);
});

test("app.js registra estado, atalhos e simulacao do editor de corte", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /const CUT_STORAGE_KEY = "router-cnc-cut-v1";/);
  assert.match(appJs, /function buildCutPlanForSheet\(sheetIndex, \{ force = false \} = \{\}\)/);
  assert.match(appJs, /function startCutSimulationForSheet\(sheetIndex = activeSheetIndex, \{ restart = false \} = \{\}\)/);
  assert.match(appJs, /function saveProjectFile\(baseName = "", silent = false\)/);
  assert.match(appJs, /function exportCutPlansToNc\(\)/);
  assert.match(appJs, /if \(editCutBtn\) \{\s*editCutBtn\.addEventListener\("click", \(\) => openCutEditorModal\(\)\);/);
  assert.match(appJs, /if \(simulateCutBtn\) \{\s*simulateCutBtn\.addEventListener\("click", \(\) =>/);
  assert.match(appJs, /if \(keyLower === "f9"\) \{\s*event\.preventDefault\(\);\s*toggleActiveSheetGrayMode\(\);/);
  assert.match(appJs, /if \(\(event\.ctrlKey \|\| event\.metaKey\) && String\(event\.key \|\| ""\)\.toLowerCase\(\) === "s"\)/);
  assert.match(appJs, /updateCutSimulation\(now\);/);
});

test("app.js cria setas de origem de corte na chapa ativa", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function buildSheetStartArrowPoints\(sheet\)/);
  assert.match(appJs, /function createSheetStartArrow\(point, sheetIndex, isSelected\)/);
  assert.match(appJs, /const isCornerMarker = \["top_left", "top_right", "bottom_right", "bottom_left"\]\.includes\(/);
  assert.match(appJs, /const markerScale = isCornerMarker \? 2 : 1;/);
  assert.match(appJs, /setSheetCutStartCorner\(sheetIndex, arrowHit\.userData\.cutStartCorner\);/);
});
