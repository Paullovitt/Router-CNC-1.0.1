import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

test("modal possui botao Aplicar em todas", () => {
  const html = readProjectFile("index.html");
  assert.match(html, /id="applyAllSheetsBtn"/);
  assert.match(html, /Aplicar em todas/);
});

test("app.js registra evento para Aplicar em todas e atualiza template global", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /const applyAllSheetsBtn = document\.getElementById\("applyAllSheetsBtn"\);/);
  assert.match(appJs, /if \(applyAllSheetsBtn\)\s*\{\s*applyAllSheetsBtn\.addEventListener\("click",/);
  assert.match(appJs, /setSheetCreationTemplate\(updated\);/);
});

test("novas chapas usam o template global em vez de copiar da chapa ativa", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /if \(newSheetBtn\)\s*\{\s*newSheetBtn\.addEventListener\("click", \(\) => \{\s*sheetState\.push\(createSheetFrom\(\)\);/);
  assert.match(appJs, /if \(allowCreateSheet\)\s*\{\s*sheetState\.push\(createSheetFrom\(\)\);/);
});

test("aplicar no editar chapa nao dispara fit automatico da camera", () => {
  const appJs = readProjectFile("app.js");
  const applyCurrentBlock = appJs.match(/if \(applySheetBtn\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const applyAllBlock = appJs.match(/if \(applyAllSheetsBtn\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(applyCurrentBlock, /fitToScene\(/);
  assert.doesNotMatch(applyAllBlock, /fitToScene\(/);
});
