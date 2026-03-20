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

test("viewport possui badge de FPS em verde", () => {
  const html = readProjectFile("index.html");
  const css = readProjectFile("styles.css");
  assert.match(html, /id="fpsBadge"/);
  assert.match(css, /\.fps-badge\s*\{/);
  assert.match(css, /color:\s*#22c55e/);
});

test("loop de render atualiza FPS periodicamente", () => {
  const appJs = readProjectFile("app.js");
  assert.match(appJs, /const fpsBadgeEl = document\.getElementById\("fpsBadge"\);/);
  assert.match(appJs, /function updateFpsBadgeText\(fps = 0\)/);
  assert.match(appJs, /if \(fpsAccumMs >= 500\) \{/);
  assert.match(appJs, /updateFpsBadgeText\(fpsDisplayValue\);/);
  assert.match(appJs, /updateFpsBadgeText\(0\);/);
});
