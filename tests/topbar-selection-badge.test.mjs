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

test("topbar nao exibe badges de render/cache e mantem badge da peca selecionada", () => {
  const html = readProjectFile("index.html");
  assert.doesNotMatch(html, /id="runtimeMode"/);
  assert.doesNotMatch(html, /id="cacheStats"/);
  assert.match(html, /id="selectedPiece"/);
});

test("badge de peca selecionada mostra codigo do arquivo sem extensao", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /function getSelectedPartCode\(part\) \{/);
  assert.match(appJs, /const code = fileName\.replace\(\/\\\.\(dxf\|step\|stp\)\$\/i, ""\)\.trim\(\);/);
  assert.match(appJs, /selectedPieceEl\.textContent = `Peca sel\.: \$\{displayCode\}`;/);
  assert.match(appJs, /updateSelectedPieceBadge\(selectedPart\);/);
});
