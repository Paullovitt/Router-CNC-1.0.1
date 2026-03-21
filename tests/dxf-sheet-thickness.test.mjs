import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function readAppJs() {
  return fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
}

test("DXF recebe metadados para sincronizar espessura por chapa", () => {
  const appJs = readAppJs();
  assert.match(appJs, /const PART_KIND_DXF = "dxf";/);
  assert.match(appJs, /function markPartAsDxf\(part, sourceThickness = DEFAULT_PART_THICKNESS\)/);
  assert.match(appJs, /localGroup\.name = filename;\s*markPartAsDxf\(localGroup, thickness\);/);
});

test("espessura DXF e ajustada por scale.z usando espessura da chapa", () => {
  const appJs = readAppJs();
  assert.match(appJs, /function applyDxfThicknessForSheet\(part, sheet\)/);
  assert.match(appJs, /const targetThickness = Math\.max\(0\.1, Number\(sheet\.thickness \|\| baseThickness\)\);/);
  assert.match(appJs, /const desiredScaleZ = baseScaleZ \* \(targetThickness \/ baseThickness\);/);
});

test("setPartZForSheet aplica regra de DXF sem impactar STEP", () => {
  const appJs = readAppJs();
  assert.match(appJs, /applyDxfThicknessForSheet\(part, sheet\);/);
  assert.match(appJs, /if \(isDxfPart\(part\)\) \{/);
  assert.match(appJs, /const zBias = THREE\.MathUtils\.clamp\(\s*sheetThickness \* 0\.01,\s*DXF_SHEET_Z_FIGHT_BIAS_MIN,\s*DXF_SHEET_Z_FIGHT_BIAS_MAX\s*\);/);
  assert.match(appJs, /part\.position\.z = Number\(sheet\.originZ \|\| 0\) - sheetThickness \* 0\.5 - zBias;/);
  assert.match(appJs, /const baseZ = Number\(sheet\.originZ \|\| 0\) \+ SHEET_PART_ELEVATION;/);
});
