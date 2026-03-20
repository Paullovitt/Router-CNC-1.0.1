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

test("pipeline de proxies inativos usa shader custom com atributos de instancia", () => {
  const appJs = readAppJs();
  assert.match(appJs, /function buildInactiveProxyShaderMaterial\(\)/);
  assert.match(appJs, /in vec3 iOffset;/);
  assert.match(appJs, /in vec3 iScale;/);
  assert.match(appJs, /in vec3 iRotation;/);
  assert.match(appJs, /in vec3 iColor;/);
  assert.match(appJs, /new THREE\.RawShaderMaterial\(/);
});

test("instancing cria atributos e desenha por instanceCount em lote", () => {
  const appJs = readAppJs();
  assert.match(appJs, /new THREE\.InstancedBufferGeometry\(/);
  assert.match(appJs, /geometry\.setAttribute\("iOffset", iOffset\);/);
  assert.match(appJs, /geometry\.setAttribute\("iScale", iScale\);/);
  assert.match(appJs, /geometry\.setAttribute\("iRotation", iRotation\);/);
  assert.match(appJs, /geometry\.setAttribute\("iColor", iColor\);/);
  assert.match(appJs, /geometry\.instanceCount = count;/);
  assert.match(appJs, /syncInactiveProxyInstancing\(\{ transitionActive \}\);/);
});
