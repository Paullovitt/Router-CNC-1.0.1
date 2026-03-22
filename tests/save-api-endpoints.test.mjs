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

test("server.py expone endpoints de salvamento local", () => {
  const serverPy = readProjectFile("server.py");
  assert.match(serverPy, /"\/api\/save-project"/);
  assert.match(serverPy, /"\/api\/save-text"/);
  assert.match(serverPy, /def normalize_project_filename\(raw: Any\) -> str:/);
  assert.match(serverPy, /def normalize_text_filename\(raw: Any, default_ext: str = "\.txt"\) -> str:/);
  assert.match(serverPy, /print\("API salvar projeto: POST \/api\/save-project"\)/);
  assert.match(serverPy, /print\("API salvar texto: POST \/api\/save-text"\)/);
});

test("server.py grava projeto e texto de forma atomica no runtime", () => {
  const serverPy = readProjectFile("server.py");
  assert.match(serverPy, /server\.save_dir = \(root \/ "runtime"\)\.resolve\(\)/);
  assert.match(serverPy, /atomic_write_bytes\(target, encoded, prefix="\.cnc3d_"\)/);
  assert.match(serverPy, /atomic_write_bytes\(target, content\.encode\("utf-8"\), prefix="\.cnc_text_"\)/);
});
