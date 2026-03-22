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

test("app.js possui regra automatica de profundidade por espessura", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /const CUT_AUTO_PASS_THICKNESS_MM = 5;/);
  assert.match(appJs, /const CUT_AUTO_BREAKTHROUGH_MM = 0\.1;/);
  assert.match(appJs, /function buildAutoCutDepthProfile\(sheetThickness, toolType, toolMeasure, requestedPassCount = null\)/);
  assert.match(appJs, /const finalDepth = Number\(\(thickness \+ CUT_AUTO_BREAKTHROUGH_MM\)\.toFixed\(3\)\);/);
  assert.match(appJs, /const basePassCount = Math\.max\(1, Math\.ceil\(thickness \/ CUT_AUTO_PASS_THICKNESS_MM\)\);/);
  assert.match(appJs, /const passCount = explicitPassCount \|\| autoPassCount;/);
});

test("app.js aplica o perfil automatico ao ler e salvar configuracao da chapa", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function applyAutoDepthProfileToCutConfig\(rawConfig, sheet\)/);
  assert.match(appJs, /sheet\.cutSettings = applyAutoDepthProfileToCutConfig\(\s*sheet\.cutSettings \|\| getDefaultSheetCutConfig\(\),\s*sheet\s*\);/);
  assert.match(appJs, /const normalized = applyAutoDepthProfileToCutConfig\(sheet\?\.cutSettings \|\| getDefaultSheetCutConfig\(\), sheet\);/);
  assert.match(appJs, /sheet\.cutSettings = applyAutoDepthProfileToCutConfig\(nextConfig, sheet\);/);
});

test("editar corte usa Passadas para calcular profundidade automaticamente", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function getRequestedCutPassCount\(fallback = null\)/);
  assert.match(appJs, /function syncCutDepthInputsForSheet\(toolLike = null, sheetIndex = activeSheetIndex, requestedPassCount = null\)/);
  assert.match(appJs, /const profile = buildAutoCutDepthProfile\(getSheetThicknessForCut\(sheet\), toolType, toolMeasure, nextPassCount\);/);
  assert.match(appJs, /if \(cutStepDownInputEl\) cutStepDownInputEl\.value = String\(profile\.passCount\);/);
  assert.match(appJs, /if \(cutFinalDepthInputEl\) cutFinalDepthInputEl\.value = String\(profile\.finalDepth\);/);
});

test("index.html altera campo existente para Passadas sem criar input extra", () => {
  const html = readProjectFile("index.html");
  assert.match(html, /<label class="field">Passadas[\s\S]*id="cutStepDownInput"/);
  assert.doesNotMatch(html, /id="cutPassCountInput"/);
});
