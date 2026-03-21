import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

// DXF parser (CDN)
import DxfParser from "https://esm.sh/dxf-parser@1.1.2";
import {
  DEFAULT_SHEET_CONFIG,
  normalizeSheetConfig,
  getSheetUsableBounds,
  findPlacementOnSheet
} from "./sheet-layout.js";

// ---------------------------
// Scene / camera / renderer
// ---------------------------
const container = document.getElementById("viewport");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);

const camera = new THREE.PerspectiveCamera(55, 1, 1, 120000);
camera.position.set(2100, 1300, 2300);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(200, 300, 150);
scene.add(dir);

// Grid / axes
const grid = new THREE.GridHelper(14000, 140, 0x334155, 0x1f2937);
grid.position.y = 0;
scene.add(grid);

const axes = new THREE.AxesHelper(180);
scene.add(axes);

// Orbit controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

// Transform controls (move selected part)
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode("translate");
scene.add(transformControls);

// ---------------------------
// Parts state
// ---------------------------
const sheetsGroup = new THREE.Group();
scene.add(sheetsGroup);

const partsGroup = new THREE.Group();
scene.add(partsGroup);

const inactiveInstancedProxyGroup = new THREE.Group();
scene.add(inactiveInstancedProxyGroup);

const bboxAll = new THREE.Box3();
const tempBox = new THREE.Box3();
const tempVec = new THREE.Vector3();
const sheetTempBox = new THREE.Box3();
const cameraDepthSizeVec = new THREE.Vector3();

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

let selectedPart = null;
let selectionOutline = null;
let pointerDownX = 0;
let pointerDownY = 0;
let pointerMoved = false;

const SHEET_GAP = 260;
const SHEET_PART_ELEVATION = 2.4;
const SHEET_PART_Z_CLAMP = 16;
const SHEET_RING_MIN_RADIUS = 1800;
const SHEET_RING_TRANSITION_MS = 420;
const CAMERA_NEAR_MIN = 0.8;
const CAMERA_NEAR_MAX = 120;
const CAMERA_FAR_MARGIN = 3.2;
const PART_KIND_DXF = "dxf";
const DEFAULT_PART_THICKNESS = 5;
const DEFAULT_AUTO_CENTER = true;
const EPS = 1e-6;
const CPU_CORES = Math.max(1, Number(navigator.hardwareConcurrency || 1));
const DXF_PARSE_WORKERS = Math.max(1, CPU_CORES);
const STEP_IMPORT_WORKERS = Math.max(1, Math.min(2, CPU_CORES));
const DXF_CACHE_DB_NAME = "dxf-3d-viewer-cache";
const DXF_PARSE_CACHE_STORE_NAME = "parsed-contours";
const DXF_MESH_CACHE_STORE_NAME = "mesh-groups";
const DXF_CACHE_SCHEMA_VERSION = 2;
const DXF_PARSE_CACHE_PIPELINE_VERSION = "browser-parse-v1";
const DXF_MESH_CACHE_PIPELINE_VERSION = "browser-mesh-v1";
const DXF_PARSE_CACHE_MAX_ENTRIES = 120;
const DXF_PARSE_CACHE_MAX_BYTES = 80 * 1024 * 1024;
const DXF_MESH_CACHE_MAX_ENTRIES = 32;
const DXF_MESH_CACHE_MAX_BYTES = 280 * 1024 * 1024;
const STEP_MESH_CACHE_PIPELINE_VERSION = "step-mesh-v1";
const DXF_PARSE_TIMEOUT_MS = 90000;
const STEP_PARSE_TIMEOUT_MS = 60000;
const ENABLE_INACTIVE_PROXY_INSTANCING = true;
const INACTIVE_PROXY_MIN_SIZE = 1;
const INACTIVE_PROXY_MIN_THICKNESS = 0.9;
const INACTIVE_PROXY_FPS_SAFE_CAP = 1 << 18;
const DXF_CACHE_STORE_NAME = DXF_PARSE_CACHE_STORE_NAME;
const DXF_CACHE_PIPELINE_VERSION = DXF_PARSE_CACHE_PIPELINE_VERSION;
const DXF_CACHE_MAX_ENTRIES = DXF_PARSE_CACHE_MAX_ENTRIES;
const DXF_CACHE_MAX_BYTES = DXF_PARSE_CACHE_MAX_BYTES;
let dxfWorkerPool = null;
let dxfCacheDbPromise = null;
let dxfCacheInitLogged = false;
const inventoryItems = [];
let inventoryNextId = 1;
let inventoryColorCursor = 0;
let inventoryFilterQuery = "";
let inventoryFilterType = "all";
let inventoryBusy = false;
const inventoryPreviewCache = new Map();
const inventoryPreviewPending = new Set();
let inventoryPreviewObserver = null;
const INVENTORY_CARD_HEIGHT = 196;
const INVENTORY_CARD_GAP = 8;
const INVENTORY_VIRTUAL_OVERSCAN_ROWS = 3;
let inventoryRenderList = [];
let inventoryVirtualSpacerEl = null;
let inventoryVirtualContentEl = null;
let inventoryVirtualColumns = 1;
let inventoryVirtualLastStart = -1;
let inventoryVirtualLastEnd = -1;
let inventoryVirtualLastOffset = -1;
let inventoryVirtualRafToken = 0;
let inventoryVirtualResizeObserver = null;
let inventoryVirtualWindowResizeBound = false;
let inactiveProxyMesh = null;
let inactiveProxyDirty = true;

function createDxfWorkerPool(workerCount) {
  if (typeof Worker === "undefined") return null;
  const count = Math.max(1, Number(workerCount || 1));
  const workerUrl = `./dxf-worker.js?v=2`;
  const slots = [];
  const queue = [];
  const pending = new Map();
  let nextId = 1;

  function dispatch() {
    for (const slot of slots) {
      if (slot.busy) continue;
      const job = queue.shift();
      if (!job) break;
      slot.busy = true;
      slot.jobId = job.id;
      pending.set(job.id, job);
      slot.worker.postMessage({
        type: "parse",
        id: job.id,
        text: job.text
      });
    }
  }

  function handleSettled(slot, id, ok, payload) {
    const job = pending.get(id);
    pending.delete(id);
    slot.busy = false;
    slot.jobId = null;
    if (!job) {
      dispatch();
      return;
    }

    if (ok) job.resolve(payload);
    else job.reject(payload instanceof Error ? payload : new Error(String(payload || "Worker error")));
    dispatch();
  }

  for (let i = 0; i < count; i += 1) {
    const worker = new Worker(workerUrl);
    const slot = { worker, busy: false, jobId: null };

    worker.onmessage = (event) => {
      const data = event?.data || {};
      const id = Number(data.id);
      if (!Number.isFinite(id)) return;
      if (data.ok) {
        handleSettled(slot, id, true, data.parsed || null);
      } else {
        handleSettled(slot, id, false, new Error(String(data.error || "Worker parse failed")));
      }
    };

    worker.onerror = (event) => {
      if (slot.jobId != null) {
        handleSettled(slot, slot.jobId, false, new Error(event?.message || "Worker execution error"));
      } else {
        slot.busy = false;
        slot.jobId = null;
      }
    };

    slots.push(slot);
  }

  function runParse(text) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      queue.push({
        id,
        text: String(text || ""),
        resolve,
        reject
      });
      dispatch();
    });
  }

  function terminate() {
    for (const slot of slots) {
      slot.worker.terminate();
      slot.busy = false;
      slot.jobId = null;
    }

    for (const [, job] of pending) {
      job.reject(new Error("Worker pool terminated"));
    }
    pending.clear();

    while (queue.length > 0) {
      const job = queue.shift();
      if (job?.reject) job.reject(new Error("Worker pool terminated"));
    }
  }

  return {
    size: count,
    runParse,
    terminate
  };
}

function getDxfWorkerPool() {
  if (dxfWorkerPool !== null) return dxfWorkerPool;
  try {
    dxfWorkerPool = createDxfWorkerPool(DXF_PARSE_WORKERS);
    return dxfWorkerPool;
  } catch (error) {
    console.warn("DXF worker pool indisponivel; fallback para parse local.", error);
    dxfWorkerPool = undefined;
    return dxfWorkerPool;
  }
}

async function parseDxfWithWorkers(dxfText, filename = "") {
  const pool = getDxfWorkerPool();
  if (!pool || typeof pool.runParse !== "function") return null;

  try {
    return await pool.runParse(dxfText);
  } catch (error) {
    console.warn("Falha no parse em worker para:", filename, error);
    return null;
  }
}

function idbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

function supportsPersistentDxfCache() {
  return typeof indexedDB !== "undefined";
}

function ensureObjectStore(db, name) {
  if (db.objectStoreNames.contains(name)) return null;
  const store = db.createObjectStore(name, { keyPath: "key" });
  store.createIndex("updatedAt", "updatedAt", { unique: false });
  return store;
}

async function openDxfCacheDb() {
  if (!supportsPersistentDxfCache()) return null;
  if (dxfCacheDbPromise) return dxfCacheDbPromise;

  dxfCacheDbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DXF_CACHE_DB_NAME, DXF_CACHE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        ensureObjectStore(db, DXF_PARSE_CACHE_STORE_NAME);
        ensureObjectStore(db, DXF_MESH_CACHE_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch (_error) {
      resolve(null);
    }
  });

  return dxfCacheDbPromise;
}

function estimateJsonSizeBytes(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch (_error) {
    return 0;
  }
}

async function computeArrayBufferHashHex(arrayBuffer) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const digest = await subtle.digest("SHA-256", arrayBuffer);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  // Fallback deterministic hash when SubtleCrypto is unavailable.
  const bytes = new Uint8Array(arrayBuffer);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16)}_${bytes.length}`;
}

function buildParsedCacheKeyFromHash(hash) {
  if (!hash) return "";
  return `${DXF_CACHE_PIPELINE_VERSION}:${hash}`;
}

function buildMeshCacheKeyFromHash(hash, thickness) {
  if (!hash) return "";
  return `${DXF_MESH_CACHE_PIPELINE_VERSION}:${hash}:t=${Number(thickness)}`;
}

function buildStepMeshCacheKeyFromHash(hash) {
  if (!hash) return "";
  return `${STEP_MESH_CACHE_PIPELINE_VERSION}:${hash}`;
}

async function buildParsedCacheKey(arrayBuffer) {
  const hash = await computeArrayBufferHashHex(arrayBuffer);
  return buildParsedCacheKeyFromHash(hash);
}

function isValidParsedPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!Array.isArray(parsed.contours)) return false;
  if (!Number.isFinite(Number(parsed.width))) return false;
  if (!Number.isFinite(Number(parsed.height))) return false;
  return true;
}

async function getParsedFromPersistentCache(cacheKey) {
  if (!cacheKey) return null;
  const db = await openDxfCacheDb();
  if (!db) return null;

  try {
    const tx = db.transaction(DXF_CACHE_STORE_NAME, "readonly");
    const store = tx.objectStore(DXF_CACHE_STORE_NAME);
    const record = await idbRequestToPromise(store.get(cacheKey));
    await waitForTransaction(tx);
    if (!record || !isValidParsedPayload(record.parsed)) return null;

    // Async touch to keep recent entries alive.
    try {
      const writeTx = db.transaction(DXF_CACHE_STORE_NAME, "readwrite");
      const writeStore = writeTx.objectStore(DXF_CACHE_STORE_NAME);
      writeStore.put({
        ...record,
        hits: Number(record.hits || 0) + 1,
        updatedAt: Date.now()
      });
    } catch (_touchError) {
      // no-op
    }

    return record.parsed;
  } catch (_error) {
    return null;
  }
}

async function trimPersistentParsedCache(db) {
  try {
    const tx = db.transaction(DXF_CACHE_STORE_NAME, "readonly");
    const store = tx.objectStore(DXF_CACHE_STORE_NAME);
    const all = await idbRequestToPromise(store.getAll());
    await waitForTransaction(tx);
    if (!Array.isArray(all) || all.length === 0) return;

    const sorted = all
      .slice()
      .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));

    const keysToDelete = new Set();
    if (sorted.length > DXF_CACHE_MAX_ENTRIES) {
      for (const rec of sorted.slice(DXF_CACHE_MAX_ENTRIES)) {
        if (rec?.key) keysToDelete.add(rec.key);
      }
    }

    let totalBytes = 0;
    for (const rec of sorted) totalBytes += Number(rec?.approxBytes || 0);

    if (totalBytes > DXF_CACHE_MAX_BYTES) {
      for (let i = sorted.length - 1; i >= 0 && totalBytes > DXF_CACHE_MAX_BYTES; i -= 1) {
        const rec = sorted[i];
        if (!rec?.key || keysToDelete.has(rec.key)) continue;
        keysToDelete.add(rec.key);
        totalBytes -= Number(rec?.approxBytes || 0);
      }
    }

    if (keysToDelete.size === 0) return;

    const writeTx = db.transaction(DXF_CACHE_STORE_NAME, "readwrite");
    const writeStore = writeTx.objectStore(DXF_CACHE_STORE_NAME);
    for (const key of keysToDelete) writeStore.delete(key);
    await waitForTransaction(writeTx);
  } catch (_error) {
    // no-op
  }
}

async function putParsedInPersistentCache(cacheKey, parsed, file) {
  if (!cacheKey || !isValidParsedPayload(parsed)) return false;
  const db = await openDxfCacheDb();
  if (!db) return false;

  const now = Date.now();
  const approxBytes = estimateJsonSizeBytes(parsed);
  const record = {
    key: cacheKey,
    parsed,
    approxBytes,
    fileName: String(file?.name || ""),
    fileSize: Number(file?.size || 0),
    createdAt: now,
    updatedAt: now,
    hits: 0
  };

  try {
    const tx = db.transaction(DXF_CACHE_STORE_NAME, "readwrite");
    const store = tx.objectStore(DXF_CACHE_STORE_NAME);
    store.put(record);
    await waitForTransaction(tx);
    await trimPersistentParsedCache(db);
    return true;
  } catch (_error) {
    return false;
  }
}

function typedArrayFromCtorName(ctorName, sourceArray) {
  switch (String(ctorName || "")) {
    case "Float32Array": return new Float32Array(sourceArray);
    case "Float64Array": return new Float64Array(sourceArray);
    case "Int8Array": return new Int8Array(sourceArray);
    case "Uint8Array": return new Uint8Array(sourceArray);
    case "Uint8ClampedArray": return new Uint8ClampedArray(sourceArray);
    case "Int16Array": return new Int16Array(sourceArray);
    case "Uint16Array": return new Uint16Array(sourceArray);
    case "Int32Array": return new Int32Array(sourceArray);
    case "Uint32Array": return new Uint32Array(sourceArray);
    default:
      return null;
  }
}

function cloneTypedArray(value) {
  if (!value || typeof value.length !== "number") return null;
  const ctorName = value.constructor?.name;
  return typedArrayFromCtorName(ctorName, value);
}

function serializeBufferAttribute(attr) {
  if (!attr || !attr.array) return null;
  const arr = cloneTypedArray(attr.array);
  if (!arr) return null;
  return {
    itemSize: Number(attr.itemSize || 0),
    normalized: !!attr.normalized,
    ctor: arr.constructor.name,
    array: arr
  };
}

function deserializeBufferAttribute(raw) {
  if (!raw || !raw.array) return null;
  const arr = typedArrayFromCtorName(raw.ctor, raw.array);
  if (!arr || !Number.isFinite(Number(raw.itemSize)) || Number(raw.itemSize) < 1) return null;
  return new THREE.BufferAttribute(arr, Number(raw.itemSize), !!raw.normalized);
}

function estimateTypedArrayBytes(value) {
  if (!value || typeof value.byteLength !== "number") return 0;
  return Number(value.byteLength || 0);
}

function serializeBufferGeometry(geometry) {
  if (!geometry || !geometry.isBufferGeometry) return null;

  const attributes = {};
  for (const [name, attr] of Object.entries(geometry.attributes || {})) {
    const serialized = serializeBufferAttribute(attr);
    if (serialized) attributes[name] = serialized;
  }

  const index = geometry.index ? serializeBufferAttribute(geometry.index) : null;
  const groups = Array.isArray(geometry.groups)
    ? geometry.groups.map((g) => ({
      start: Number(g.start || 0),
      count: Number(g.count || 0),
      materialIndex: Number(g.materialIndex || 0)
    }))
    : [];

  return {
    attributes,
    index,
    groups
  };
}

function deserializeBufferGeometry(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const geometry = new THREE.BufferGeometry();

  for (const [name, rawAttr] of Object.entries(snapshot.attributes || {})) {
    const attr = deserializeBufferAttribute(rawAttr);
    if (attr) geometry.setAttribute(name, attr);
  }

  if (snapshot.index) {
    const indexAttr = deserializeBufferAttribute(snapshot.index);
    if (indexAttr) geometry.setIndex(indexAttr);
  }

  if (Array.isArray(snapshot.groups) && snapshot.groups.length > 0) {
    geometry.clearGroups();
    for (const g of snapshot.groups) {
      geometry.addGroup(
        Number(g?.start || 0),
        Number(g?.count || 0),
        Number(g?.materialIndex || 0)
      );
    }
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function serializeMeshMaterial(material) {
  const mat = Array.isArray(material) ? material[0] : material;
  if (!mat) return null;
  const colorHex = mat.color ? mat.color.getHex() : 0x8b5cf6;
  return {
    color: Number(colorHex),
    metalness: Number(mat.metalness ?? 0.05),
    roughness: Number(mat.roughness ?? 0.85),
    opacity: Number(mat.opacity ?? 1),
    transparent: !!mat.transparent,
    side: Number(mat.side ?? THREE.FrontSide)
  };
}

function deserializeMeshMaterial(snapshot) {
  const data = snapshot || {};
  return new THREE.MeshStandardMaterial({
    color: Number(data.color ?? 0x8b5cf6),
    metalness: Number(data.metalness ?? 0.05),
    roughness: Number(data.roughness ?? 0.85),
    opacity: Number(data.opacity ?? 1),
    transparent: !!data.transparent,
    side: Number(data.side ?? THREE.FrontSide)
  });
}

function serializeSelectionPrimaryLoop(loop) {
  if (!Array.isArray(loop) || loop.length < 3) return null;
  const out = [];
  for (const p of loop) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out.length >= 3 ? out : null;
}

function deserializeSelectionPrimaryLoop(rawLoop) {
  if (!Array.isArray(rawLoop) || rawLoop.length < 3) return null;
  const out = [];
  for (const p of rawLoop) {
    const x = Number(Array.isArray(p) ? p[0] : p?.x);
    const y = Number(Array.isArray(p) ? p[1] : p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push(new THREE.Vector2(x, y));
  }
  return out.length >= 3 ? out : null;
}

function serializeMeshGroupSnapshot(localGroup, thickness) {
  if (!localGroup || !localGroup.isObject3D) return null;
  localGroup.updateMatrixWorld(true);

  const meshes = [];
  localGroup.traverse((node) => {
    if (!node?.isMesh || !node.geometry) return;
    const geometry = serializeBufferGeometry(node.geometry);
    if (!geometry) return;
    const material = serializeMeshMaterial(node.material);

    meshes.push({
      name: String(node.name || ""),
      geometry,
      material,
      position: [node.position.x, node.position.y, node.position.z],
      quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      scale: [node.scale.x, node.scale.y, node.scale.z]
    });
  });

  if (meshes.length === 0) return null;

  return {
    thickness: Number(thickness),
    selectionPrimaryLoop: serializeSelectionPrimaryLoop(localGroup.userData?.selectionPrimaryLoop),
    meshes
  };
}

function estimateMeshSnapshotBytes(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.meshes)) return 0;
  let total = 0;
  for (const mesh of snapshot.meshes) {
    const index = mesh?.geometry?.index;
    if (index?.array) total += estimateTypedArrayBytes(index.array);
    for (const attr of Object.values(mesh?.geometry?.attributes || {})) {
      if (attr?.array) total += estimateTypedArrayBytes(attr.array);
    }
    total += 256;
  }
  return total;
}

function buildGroupFromMeshSnapshot(snapshot, fallbackName = "") {
  if (!snapshot || !Array.isArray(snapshot.meshes) || snapshot.meshes.length === 0) return null;

  const group = new THREE.Group();
  group.name = String(fallbackName || "arquivo.dxf");

  const selLoop = deserializeSelectionPrimaryLoop(snapshot.selectionPrimaryLoop);
  if (selLoop) group.userData.selectionPrimaryLoop = selLoop;

  for (const meshData of snapshot.meshes) {
    const geometry = deserializeBufferGeometry(meshData.geometry);
    if (!geometry) continue;
    const material = deserializeMeshMaterial(meshData.material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = String(meshData?.name || "");

    const pos = Array.isArray(meshData?.position) ? meshData.position : [];
    const quat = Array.isArray(meshData?.quaternion) ? meshData.quaternion : [];
    const scale = Array.isArray(meshData?.scale) ? meshData.scale : [];
    if (pos.length === 3) mesh.position.set(Number(pos[0]), Number(pos[1]), Number(pos[2]));
    if (quat.length === 4) mesh.quaternion.set(Number(quat[0]), Number(quat[1]), Number(quat[2]), Number(quat[3]));
    if (scale.length === 3) mesh.scale.set(Number(scale[0]), Number(scale[1]), Number(scale[2]));

    group.add(mesh);
  }

  return group.children.length > 0 ? group : null;
}

async function trimPersistentMeshCache(db) {
  try {
    const tx = db.transaction(DXF_MESH_CACHE_STORE_NAME, "readonly");
    const store = tx.objectStore(DXF_MESH_CACHE_STORE_NAME);
    const all = await idbRequestToPromise(store.getAll());
    await waitForTransaction(tx);
    if (!Array.isArray(all) || all.length === 0) return;

    const sorted = all
      .slice()
      .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));

    const keysToDelete = new Set();
    if (sorted.length > DXF_MESH_CACHE_MAX_ENTRIES) {
      for (const rec of sorted.slice(DXF_MESH_CACHE_MAX_ENTRIES)) {
        if (rec?.key) keysToDelete.add(rec.key);
      }
    }

    let totalBytes = 0;
    for (const rec of sorted) totalBytes += Number(rec?.approxBytes || 0);
    if (totalBytes > DXF_MESH_CACHE_MAX_BYTES) {
      for (let i = sorted.length - 1; i >= 0 && totalBytes > DXF_MESH_CACHE_MAX_BYTES; i -= 1) {
        const rec = sorted[i];
        if (!rec?.key || keysToDelete.has(rec.key)) continue;
        keysToDelete.add(rec.key);
        totalBytes -= Number(rec?.approxBytes || 0);
      }
    }

    if (keysToDelete.size === 0) return;

    const writeTx = db.transaction(DXF_MESH_CACHE_STORE_NAME, "readwrite");
    const writeStore = writeTx.objectStore(DXF_MESH_CACHE_STORE_NAME);
    for (const key of keysToDelete) writeStore.delete(key);
    await waitForTransaction(writeTx);
  } catch (_error) {
    // no-op
  }
}

async function getMeshGroupFromPersistentCache(cacheKey, fallbackName = "") {
  if (!cacheKey) return null;
  const db = await openDxfCacheDb();
  if (!db) return null;

  try {
    const tx = db.transaction(DXF_MESH_CACHE_STORE_NAME, "readonly");
    const store = tx.objectStore(DXF_MESH_CACHE_STORE_NAME);
    const record = await idbRequestToPromise(store.get(cacheKey));
    await waitForTransaction(tx);
    if (!record?.snapshot) return null;

    const group = buildGroupFromMeshSnapshot(record.snapshot, fallbackName || record.fileName || "");
    if (!group) return null;

    try {
      const writeTx = db.transaction(DXF_MESH_CACHE_STORE_NAME, "readwrite");
      const writeStore = writeTx.objectStore(DXF_MESH_CACHE_STORE_NAME);
      writeStore.put({
        ...record,
        hits: Number(record.hits || 0) + 1,
        updatedAt: Date.now()
      });
    } catch (_touchError) {
      // no-op
    }

    return group;
  } catch (_error) {
    return null;
  }
}

async function putMeshGroupInPersistentCache(cacheKey, localGroup, file, thickness) {
  if (!cacheKey || !localGroup) return false;
  const db = await openDxfCacheDb();
  if (!db) return false;

  const snapshot = serializeMeshGroupSnapshot(localGroup, thickness);
  if (!snapshot) return false;

  const now = Date.now();
  const record = {
    key: cacheKey,
    snapshot,
    approxBytes: estimateMeshSnapshotBytes(snapshot),
    fileName: String(file?.name || ""),
    fileSize: Number(file?.size || 0),
    thickness: Number(thickness),
    createdAt: now,
    updatedAt: now,
    hits: 0
  };

  try {
    const tx = db.transaction(DXF_MESH_CACHE_STORE_NAME, "readwrite");
    const store = tx.objectStore(DXF_MESH_CACHE_STORE_NAME);
    store.put(record);
    await waitForTransaction(tx);
    await trimPersistentMeshCache(db);
    return true;
  } catch (_error) {
    return false;
  }
}

function cachePartBounds(part) {
  if (!part) return null;
  part.updateMatrixWorld(true);
  const cached = (part.userData?.layoutBounds instanceof THREE.Box3)
    ? part.userData.layoutBounds
    : new THREE.Box3();
  cached.setFromObject(part);
  part.userData.layoutBounds = cached;
  inactiveProxyDirty = true;
  return cached;
}

function getCachedPartBounds(part) {
  if (!part) return null;
  const cached = part.userData?.layoutBounds;
  if (cached instanceof THREE.Box3) return cached;
  return cachePartBounds(part);
}

const sheetState = [];
let activeSheetIndex = 0;
let sheetCreationTemplate = normalizeSheetConfig(DEFAULT_SHEET_CONFIG, DEFAULT_SHEET_CONFIG);
let sheetRingTransition = null;

function getValidSheetIndex(index) {
  const numeric = Number(index);
  if (!Number.isFinite(numeric)) return -1;
  const parsed = Math.trunc(numeric);
  if (parsed < 0 || parsed >= sheetState.length) return -1;
  return parsed;
}

function cloneSheetConfig(config) {
  return {
    ...normalizeSheetConfig(config, DEFAULT_SHEET_CONFIG),
    originX: 0,
    originY: 0,
    originZ: 0
  };
}

function getSheetCreationTemplate() {
  return normalizeSheetConfig(sheetCreationTemplate, DEFAULT_SHEET_CONFIG);
}

function setSheetCreationTemplate(config) {
  sheetCreationTemplate = normalizeSheetConfig(config, DEFAULT_SHEET_CONFIG);
}

function createSheetFrom(config = null) {
  const source = config || getSheetCreationTemplate();
  return cloneSheetConfig(source);
}

function shouldUseInactiveProxyInstancing() {
  return ENABLE_INACTIVE_PROXY_INSTANCING && !!renderer.capabilities?.isWebGL2;
}

function buildInactiveProxyShaderMaterial() {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uOpacity: { value: 0.86 }
    },
    vertexShader: `#version 300 es
      precision highp float;
      in vec3 position;
      in vec3 normal;
      in vec3 iOffset;
      in vec3 iScale;
      in vec3 iRotation;
      in vec3 iColor;

      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;

      out vec3 vColor;
      out float vLight;

      mat3 rotX(float a) {
        float c = cos(a);
        float s = sin(a);
        return mat3(
          1.0, 0.0, 0.0,
          0.0, c, -s,
          0.0, s, c
        );
      }

      mat3 rotY(float a) {
        float c = cos(a);
        float s = sin(a);
        return mat3(
          c, 0.0, s,
          0.0, 1.0, 0.0,
          -s, 0.0, c
        );
      }

      mat3 rotZ(float a) {
        float c = cos(a);
        float s = sin(a);
        return mat3(
          c, -s, 0.0,
          s, c, 0.0,
          0.0, 0.0, 1.0
        );
      }

      void main() {
        mat3 rot = rotZ(iRotation.z) * rotY(iRotation.y) * rotX(iRotation.x);
        vec3 local = rot * (position * iScale);
        vec3 world = iOffset + local;
        vec3 lightDir = normalize(vec3(0.48, 0.92, 0.61));
        vec3 nrm = normalize(rot * normal);
        vLight = max(dot(nrm, lightDir), 0.24);
        vColor = iColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: `#version 300 es
      precision highp float;
      in vec3 vColor;
      in float vLight;
      uniform float uOpacity;
      out vec4 outColor;

      void main() {
        outColor = vec4(vColor * vLight, uOpacity);
      }
    `
  });
}

function createInactiveProxyInstancedMesh(capacity = 1) {
  const instanceCapacity = Math.max(1, Math.trunc(capacity || 1));
  const geometry = new THREE.InstancedBufferGeometry();
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const boxPositions = boxGeometry.getAttribute("position");
  const boxNormals = boxGeometry.getAttribute("normal");
  geometry.setAttribute("position", boxPositions.clone());
  geometry.setAttribute("normal", boxNormals.clone());
  boxGeometry.dispose();

  const iOffset = new THREE.InstancedBufferAttribute(new Float32Array(instanceCapacity * 3), 3);
  const iScale = new THREE.InstancedBufferAttribute(new Float32Array(instanceCapacity * 3), 3);
  const iRotation = new THREE.InstancedBufferAttribute(new Float32Array(instanceCapacity * 3), 3);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(instanceCapacity * 3), 3);
  iOffset.setUsage(THREE.DynamicDrawUsage);
  iScale.setUsage(THREE.DynamicDrawUsage);
  iRotation.setUsage(THREE.DynamicDrawUsage);
  iColor.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("iOffset", iOffset);
  geometry.setAttribute("iScale", iScale);
  geometry.setAttribute("iRotation", iRotation);
  geometry.setAttribute("iColor", iColor);
  geometry.instanceCount = 0;
  geometry.userData.instanceCapacity = instanceCapacity;

  const material = buildInactiveProxyShaderMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "__inactiveProxyInstancedMesh";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.visible = false;
  inactiveInstancedProxyGroup.add(mesh);
  return mesh;
}

function disposeInactiveProxyInstancedMesh() {
  if (!inactiveProxyMesh) return;
  if (inactiveProxyMesh.parent) inactiveProxyMesh.parent.remove(inactiveProxyMesh);
  if (inactiveProxyMesh.geometry) inactiveProxyMesh.geometry.dispose();
  if (inactiveProxyMesh.material) inactiveProxyMesh.material.dispose();
  inactiveProxyMesh = null;
}

function getInactiveProxyCapacityTarget(requiredCount) {
  const required = Math.max(1, Math.trunc(requiredCount || 1));
  const pow = Math.ceil(Math.log2(required));
  const sized = 2 ** Math.max(0, pow);
  if (sized > INACTIVE_PROXY_FPS_SAFE_CAP) return required;
  return sized;
}

function ensureInactiveProxyInstancedMesh(requiredCount) {
  const required = Math.max(1, Math.trunc(requiredCount || 1));
  if (!inactiveProxyMesh) {
    inactiveProxyMesh = createInactiveProxyInstancedMesh(getInactiveProxyCapacityTarget(required));
    return inactiveProxyMesh;
  }

  const capacity = Number(inactiveProxyMesh.geometry?.userData?.instanceCapacity || 0);
  if (capacity >= required) return inactiveProxyMesh;

  const nextCapacity = getInactiveProxyCapacityTarget(required);
  disposeInactiveProxyInstancedMesh();
  inactiveProxyMesh = createInactiveProxyInstancedMesh(nextCapacity);
  return inactiveProxyMesh;
}

function resolveInactiveProxyColor(part, colorOut = new THREE.Color()) {
  const cached = part?.userData?.inactiveProxyColor;
  if (Array.isArray(cached) && cached.length === 3) {
    colorOut.setRGB(
      Number(cached[0] || 0),
      Number(cached[1] || 0),
      Number(cached[2] || 0)
    );
    return colorOut;
  }

  const sourceType = String(part?.userData?.sourceType || "dxf").toLowerCase();
  if (sourceType === "step") colorOut.setHex(0x60a5fa);
  else colorOut.setHex(0x34d399);
  colorOut.offsetHSL(0, 0.02, -0.08);
  part.userData.inactiveProxyColor = [colorOut.r, colorOut.g, colorOut.b];
  return colorOut;
}

function syncInactiveProxyInstancing({ force = false, transitionActive = false } = {}) {
  if (!shouldUseInactiveProxyInstancing()) {
    disposeInactiveProxyInstancedMesh();
    for (const part of partsGroup.children) part.visible = true;
    inactiveProxyDirty = false;
    return;
  }

  if (transitionActive) {
    if (inactiveProxyMesh) inactiveProxyMesh.visible = false;
    for (const part of partsGroup.children) part.visible = true;
    inactiveProxyDirty = true;
    return;
  }

  if (!force && !inactiveProxyDirty) return;

  const proxiedParts = [];
  for (const part of partsGroup.children) {
    if (!part?.isObject3D) continue;
    const sheetIndex = getValidSheetIndex(part.userData?.sheetIndex);
    const keepMesh = part === selectedPart || sheetIndex < 0 || sheetIndex === activeSheetIndex;
    part.visible = keepMesh;
    if (!keepMesh) proxiedParts.push(part);
  }

  if (proxiedParts.length === 0) {
    if (inactiveProxyMesh) {
      inactiveProxyMesh.geometry.instanceCount = 0;
      inactiveProxyMesh.visible = false;
    }
    inactiveProxyDirty = false;
    return;
  }

  const mesh = ensureInactiveProxyInstancedMesh(proxiedParts.length);
  const geometry = mesh.geometry;
  const offsetAttr = geometry.getAttribute("iOffset");
  const scaleAttr = geometry.getAttribute("iScale");
  const rotationAttr = geometry.getAttribute("iRotation");
  const colorAttr = geometry.getAttribute("iColor");
  const tempColor = new THREE.Color();

  let count = 0;
  for (const part of proxiedParts) {
    const bounds = getCachedPartBounds(part);
    if (!(bounds instanceof THREE.Box3) || bounds.isEmpty()) {
      part.visible = true;
      continue;
    }

    const sizeX = Math.max(INACTIVE_PROXY_MIN_SIZE, Number(bounds.max.x) - Number(bounds.min.x));
    const sizeY = Math.max(INACTIVE_PROXY_MIN_SIZE, Number(bounds.max.y) - Number(bounds.min.y));
    const sizeZ = Math.max(INACTIVE_PROXY_MIN_THICKNESS, Number(bounds.max.z) - Number(bounds.min.z));
    const centerX = (Number(bounds.min.x) + Number(bounds.max.x)) * 0.5;
    const centerY = (Number(bounds.min.y) + Number(bounds.max.y)) * 0.5;
    const centerZ = (Number(bounds.min.z) + Number(bounds.max.z)) * 0.5;

    offsetAttr.setXYZ(count, centerX, centerY, centerZ);
    scaleAttr.setXYZ(count, sizeX, sizeY, sizeZ);
    rotationAttr.setXYZ(count, 0, 0, Number(part.rotation?.z || 0));
    const color = resolveInactiveProxyColor(part, tempColor);
    colorAttr.setXYZ(count, color.r, color.g, color.b);
    count += 1;
  }

  geometry.instanceCount = count;
  mesh.visible = count > 0;
  offsetAttr.needsUpdate = true;
  scaleAttr.needsUpdate = true;
  rotationAttr.needsUpdate = true;
  colorAttr.needsUpdate = true;
  inactiveProxyDirty = false;
}

function occupiedBoxesForSheet(sheetIndex, exceptPart = null) {
  const occupied = [];
  const target = Number(sheetIndex);
  for (const part of partsGroup.children) {
    if (!part || part === exceptPart) continue;
    if (Number(part.userData?.sheetIndex) !== target) continue;
    const bounds = getCachedPartBounds(part);
    if (!bounds) continue;
    occupied.push({
      minX: bounds.min.x,
      minY: bounds.min.y,
      maxX: bounds.max.x,
      maxY: bounds.max.y
    });
  }
  return occupied;
}

function getPartSizeXY(part) {
  const bounds = getCachedPartBounds(part);
  if (!bounds) return null;
  const width = Math.max(0, Number(bounds.max.x) - Number(bounds.min.x));
  const height = Math.max(0, Number(bounds.max.y) - Number(bounds.min.y));
  if (width <= EPS || height <= EPS) return null;
  return { width, height, bounds };
}

function isDxfPart(part) {
  const explicitKind = String(part?.userData?.partKind || "").toLowerCase();
  if (explicitKind) return explicitKind === PART_KIND_DXF;
  return /\.dxf$/i.test(String(part?.name || ""));
}

function ensureDxfPartMetadata(part, fallbackThickness = DEFAULT_PART_THICKNESS) {
  if (!part || !isDxfPart(part)) return false;
  if (!part.userData || typeof part.userData !== "object") part.userData = {};
  part.userData.partKind = PART_KIND_DXF;

  const baseScale = Number(part.userData.baseDxfScaleZ);
  if (!Number.isFinite(baseScale) || Math.abs(baseScale) <= EPS) {
    const currentScaleZ = Number(part.scale?.z || 1);
    part.userData.baseDxfScaleZ = Number.isFinite(currentScaleZ) && Math.abs(currentScaleZ) > EPS
      ? currentScaleZ
      : 1;
  }

  const baseThickness = Number(part.userData.baseDxfThickness);
  if (!Number.isFinite(baseThickness) || baseThickness <= EPS) {
    const fallback = Number(part.userData.appliedDxfThickness || fallbackThickness || DEFAULT_PART_THICKNESS);
    part.userData.baseDxfThickness = Math.max(0.1, Number.isFinite(fallback) ? fallback : DEFAULT_PART_THICKNESS);
  }
  return true;
}

function markPartAsDxf(part, sourceThickness = DEFAULT_PART_THICKNESS) {
  if (!part) return;
  const baseThickness = Math.max(0.1, Number(sourceThickness || DEFAULT_PART_THICKNESS));
  if (!part.userData || typeof part.userData !== "object") part.userData = {};
  part.userData.partKind = PART_KIND_DXF;
  part.userData.baseDxfThickness = baseThickness;
  part.userData.baseDxfScaleZ = Math.abs(Number(part.scale?.z || 1)) > EPS ? Number(part.scale?.z || 1) : 1;
  part.userData.appliedDxfThickness = baseThickness;
}

function applyDxfThicknessForSheet(part, sheet) {
  if (!part || !sheet) return false;
  if (!ensureDxfPartMetadata(part, Number(sheet.thickness || DEFAULT_PART_THICKNESS))) return false;

  const baseThickness = Math.max(0.1, Number(part.userData.baseDxfThickness || DEFAULT_PART_THICKNESS));
  const baseScaleZ = Number(part.userData.baseDxfScaleZ || 1);
  const targetThickness = Math.max(0.1, Number(sheet.thickness || baseThickness));
  const desiredScaleZ = baseScaleZ * (targetThickness / baseThickness);
  const currentScaleZ = Number(part.scale?.z || 1);
  let changed = false;

  if (Number.isFinite(desiredScaleZ) && Math.abs(currentScaleZ - desiredScaleZ) > 1e-6) {
    part.scale.z = desiredScaleZ;
    changed = true;
  }
  part.userData.appliedDxfThickness = targetThickness;
  return changed;
}

function setPartZForSheet(part, sheet) {
  if (!part || !sheet) return;
  applyDxfThicknessForSheet(part, sheet);

  if (isDxfPart(part)) {
    const sheetThickness = Math.max(0.1, Number(sheet.thickness || DEFAULT_PART_THICKNESS));
    part.position.z = Number(sheet.originZ || 0) - sheetThickness * 0.5;
    return;
  }

  const baseZ = Number(sheet.originZ || 0) + SHEET_PART_ELEVATION;
  part.position.z = THREE.MathUtils.clamp(
    Number(part.position.z || baseZ),
    baseZ - SHEET_PART_Z_CLAMP,
    baseZ + SHEET_PART_Z_CLAMP
  );
}

function shiftPartBoundsCache(part, dx, dy, dz) {
  const cached = part?.userData?.layoutBounds;
  if (!(cached instanceof THREE.Box3)) return false;
  cached.min.x += dx;
  cached.max.x += dx;
  cached.min.y += dy;
  cached.max.y += dy;
  cached.min.z += dz;
  cached.max.z += dz;
  inactiveProxyDirty = true;
  return true;
}

function clampPartToSheet(part) {
  if (!part) return false;
  const sheetIndex = getValidSheetIndex(part.userData?.sheetIndex);
  if (sheetIndex < 0) return false;
  const sheet = sheetState[sheetIndex];
  if (!sheet) return false;

  const size = getPartSizeXY(part);
  if (!size) return false;
  const usable = getSheetUsableBounds(sheet, sheet.originX, sheet.originY);
  if (size.width > usable.width + EPS || size.height > usable.height + EPS) return false;

  const maxStartX = usable.maxX - size.width;
  const maxStartY = usable.maxY - size.height;
  const targetMinX = THREE.MathUtils.clamp(size.bounds.min.x, usable.minX, maxStartX);
  const targetMinY = THREE.MathUtils.clamp(size.bounds.min.y, usable.minY, maxStartY);
  const dx = targetMinX - size.bounds.min.x;
  const dy = targetMinY - size.bounds.min.y;
  if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
    part.position.x += dx;
    part.position.y += dy;
  }
  setPartZForSheet(part, sheet);
  cachePartBounds(part);
  return true;
}

function tryPlacePartOnSheet(part, sheetIndex) {
  const idx = getValidSheetIndex(sheetIndex);
  if (idx < 0 || !part) return false;
  const sheet = sheetState[idx];
  if (!sheet) return false;
  const partSize = getPartSizeXY(part);
  if (!partSize) return false;

  const usable = getSheetUsableBounds(sheet, sheet.originX, sheet.originY);
  const placement = findPlacementOnSheet({
    partWidth: partSize.width,
    partHeight: partSize.height,
    usableBounds: usable,
    occupiedBoxes: occupiedBoxesForSheet(idx, part),
    spacing: sheet.spacing
  });
  if (!placement) return false;

  const dx = Number(placement.x) - Number(partSize.bounds.min.x);
  const dy = Number(placement.y) - Number(partSize.bounds.min.y);
  part.position.x += dx;
  part.position.y += dy;
  setPartZForSheet(part, sheet);
  part.userData.sheetIndex = idx;
  cachePartBounds(part);
  return true;
}

function stopSheetRingTransition() {
  sheetRingTransition = null;
}

function getSheetOriginsSnapshot() {
  return sheetState.map((sheet) => ({
    x: Number(sheet.originX || 0),
    y: Number(sheet.originY || 0),
    z: Number(sheet.originZ || 0)
  }));
}

function computeSheetRingOrigins(targetActiveIndex = activeSheetIndex) {
  const total = sheetState.length;
  if (total === 0) return [];

  const safeActive = Math.max(0, Math.min(total - 1, Number(targetActiveIndex) || 0));
  let maxWidth = 0;
  for (const sheet of sheetState) {
    const width = Number(sheet?.width || 0);
    if (Number.isFinite(width) && width > maxWidth) maxWidth = width;
  }
  maxWidth = Math.max(maxWidth, 1200);

  const circumferenceTarget = total * (maxWidth + SHEET_GAP);
  const radius = Math.max(SHEET_RING_MIN_RADIUS, circumferenceTarget / (Math.PI * 2));
  const angleStep = (Math.PI * 2) / Math.max(1, total);
  const frontAngle = Math.PI * 0.5;
  const origins = [];

  for (let idx = 0; idx < total; idx += 1) {
    const angle = frontAngle + (idx - safeActive) * angleStep;
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const sheet = sheetState[idx];
    origins.push({
      originX: centerX - Number(sheet.width) * 0.5,
      originY: 0,
      originZ: centerZ
    });
  }
  return origins;
}

function applySheetOriginsFromArray(origins, { preservePartPositions = true } = {}) {
  const oldOrigins = getSheetOriginsSnapshot();
  for (let i = 0; i < sheetState.length; i += 1) {
    const next = origins[i] || {};
    sheetState[i].originX = Number(next.originX || 0);
    sheetState[i].originY = Number(next.originY || 0);
    sheetState[i].originZ = Number(next.originZ || 0);
  }
  if (!preservePartPositions) return;

  for (const part of partsGroup.children) {
    const sheetIndex = getValidSheetIndex(part.userData?.sheetIndex);
    if (sheetIndex < 0) continue;
    const prev = oldOrigins[sheetIndex];
    const current = sheetState[sheetIndex];
    if (!prev || !current) continue;
    const dx = Number(current.originX || 0) - Number(prev.x || 0);
    const dz = Number(current.originZ || 0) - Number(prev.z || 0);
    if (Math.abs(dx) > EPS) part.position.x += dx;
    if (Math.abs(dz) > EPS) part.position.z += dz;
    if (!shiftPartBoundsCache(part, dx, 0, dz)) cachePartBounds(part);
  }
}

function syncSheetsOrigins({ preservePartPositions = true } = {}) {
  stopSheetRingTransition();
  const targets = computeSheetRingOrigins(activeSheetIndex);
  applySheetOriginsFromArray(targets, { preservePartPositions });
}

function startSheetRingTransition(durationMs = SHEET_RING_TRANSITION_MS) {
  stopSheetRingTransition();
  if (sheetState.length <= 1) {
    syncSheetsOrigins({ preservePartPositions: true });
    rebuildSheetsVisuals();
    updateGlobalBounds();
    return;
  }

  const startOrigins = getSheetOriginsSnapshot();
  const targetOrigins = computeSheetRingOrigins(activeSheetIndex).map((origin) => ({
    x: Number(origin.originX || 0),
    y: Number(origin.originY || 0),
    z: Number(origin.originZ || 0)
  }));

  let changed = false;
  for (let i = 0; i < startOrigins.length; i += 1) {
    const start = startOrigins[i];
    const target = targetOrigins[i];
    if (!start || !target) continue;
    if (Math.abs(start.x - target.x) > EPS || Math.abs(start.z - target.z) > EPS) {
      changed = true;
      break;
    }
  }
  if (!changed) {
    syncSheetsOrigins({ preservePartPositions: true });
    rebuildSheetsVisuals();
    updateGlobalBounds();
    return;
  }

  sheetRingTransition = {
    startAt: performance.now(),
    durationMs: Math.max(120, Number(durationMs || SHEET_RING_TRANSITION_MS)),
    from: startOrigins,
    to: targetOrigins
  };
}

function updateSheetRingTransition(nowMs = performance.now()) {
  if (!sheetRingTransition) return false;
  const elapsed = nowMs - Number(sheetRingTransition.startAt || nowMs);
  const duration = Math.max(1, Number(sheetRingTransition.durationMs || SHEET_RING_TRANSITION_MS));
  const t = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
  const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const interpolated = sheetRingTransition.from.map((start, idx) => {
    const target = sheetRingTransition.to[idx] || start;
    return {
      originX: THREE.MathUtils.lerp(Number(start?.x || 0), Number(target?.x || 0), eased),
      originY: 0,
      originZ: THREE.MathUtils.lerp(Number(start?.z || 0), Number(target?.z || 0), eased)
    };
  });
  applySheetOriginsFromArray(interpolated, { preservePartPositions: true });
  rebuildSheetsVisuals();

  if (t >= 1) {
    stopSheetRingTransition();
    updateGlobalBounds();
    updateSheetListUi();
    updateSheetInfoBadge();
  }
  return true;
}

function clearSheetVisuals() {
  while (sheetsGroup.children.length) {
    const child = sheetsGroup.children[0];
    sheetsGroup.remove(child);
    disposeObject3D(child);
  }
}

function createSheetBorderLine(minX, minY, maxX, maxY, colorHex) {
  const points = [
    new THREE.Vector3(minX, minY, 0),
    new THREE.Vector3(maxX, minY, 0),
    new THREE.Vector3(maxX, maxY, 0),
    new THREE.Vector3(minX, maxY, 0),
    new THREE.Vector3(minX, minY, 0)
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.95,
    toneMapped: false
  });
  return new THREE.Line(geometry, material);
}

function createSheetVolumeEdges(boxGeometry, colorHex) {
  const edgeGeometry = new THREE.EdgesGeometry(boxGeometry);
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.92,
    toneMapped: false
  });
  return new THREE.LineSegments(edgeGeometry, edgeMaterial);
}

function rebuildSheetsVisuals() {
  clearSheetVisuals();
  for (let idx = 0; idx < sheetState.length; idx += 1) {
    const sheet = sheetState[idx];
    if (!sheet) continue;

    const isActive = idx === activeSheetIndex;
    const centerX = Number(sheet.originX) + Number(sheet.width) * 0.5;
    const centerY = Number(sheet.originY) + Number(sheet.height) * 0.5;
    const thickness = Math.max(0.8, Number(sheet.thickness || 1));
    const plateZ = Number(sheet.originZ || 0) - thickness * 0.5;

    const wrapper = new THREE.Group();
    wrapper.name = `sheet-${idx + 1}`;

    const bodyGeo = new THREE.BoxGeometry(Number(sheet.width), Number(sheet.height), thickness);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x19232f,
      roughness: 0.94,
      metalness: 0.02,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      emissive: 0x000000,
      emissiveIntensity: 0
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.position.set(centerX, centerY, plateZ);
    bodyMesh.userData.sheetIndex = idx;
    wrapper.add(bodyMesh);

    const thicknessEdges = createSheetVolumeEdges(
      bodyGeo,
      isActive ? 0x38bdf8 : 0x475569
    );
    thicknessEdges.position.set(centerX, centerY, plateZ);
    wrapper.add(thicknessEdges);

    const border = createSheetBorderLine(
      Number(sheet.originX),
      Number(sheet.originY),
      Number(sheet.originX) + Number(sheet.width),
      Number(sheet.originY) + Number(sheet.height),
      isActive ? 0x38bdf8 : 0x64748b
    );
    border.position.z = Number(sheet.originZ || 0) + 0.35;
    wrapper.add(border);

    const usable = getSheetUsableBounds(sheet, sheet.originX, sheet.originY);
    const usableBorder = createSheetBorderLine(
      usable.minX,
      usable.minY,
      usable.maxX,
      usable.maxY,
      isActive ? 0x22c55e : 0x4b5563
    );
    usableBorder.position.z = Number(sheet.originZ || 0) + 0.55;
    wrapper.add(usableBorder);

    sheetsGroup.add(wrapper);
  }
}

function piecesInSheet(sheetIndex) {
  const idx = Number(sheetIndex);
  let total = 0;
  for (const part of partsGroup.children) {
    if (Number(part.userData?.sheetIndex) === idx) total += 1;
  }
  return total;
}

function relayoutSheetPieces(sheetIndex) {
  const idx = getValidSheetIndex(sheetIndex);
  if (idx < 0) return;
  const parts = partsGroup.children
    .filter((part) => Number(part.userData?.sheetIndex) === idx)
    .slice()
    .sort((a, b) => {
      const ba = getCachedPartBounds(a);
      const bb = getCachedPartBounds(b);
      const areaA = ba ? (ba.max.x - ba.min.x) * (ba.max.y - ba.min.y) : 0;
      const areaB = bb ? (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) : 0;
      return areaB - areaA;
    });

  for (const part of parts) {
    if (!tryPlacePartOnSheet(part, idx)) {
      assignPartToSheet(part, idx, { allowCreateSheet: true, searchAllSheets: true });
    }
  }
}

function assignPartToSheet(
  part,
  preferredSheetIndex = activeSheetIndex,
  { allowCreateSheet = true, searchAllSheets = true } = {}
) {
  if (!part) return false;
  const originalSheet = getValidSheetIndex(part.userData?.sheetIndex);
  const originalPosition = part.position.clone();

  const target = getValidSheetIndex(preferredSheetIndex);
  const candidates = [];
  if (target >= 0) candidates.push(target);
  if (searchAllSheets) {
    for (let idx = 0; idx < sheetState.length; idx += 1) {
      if (!candidates.includes(idx)) candidates.push(idx);
    }
  }

  for (const idx of candidates) {
    if (tryPlacePartOnSheet(part, idx)) return true;
  }

  if (allowCreateSheet) {
    sheetState.push(createSheetFrom());
    setActiveSheet(sheetState.length - 1, { animate: false });

    if (tryPlacePartOnSheet(part, activeSheetIndex)) return true;
  }

  part.position.copy(originalPosition);
  if (originalSheet >= 0) part.userData.sheetIndex = originalSheet;
  cachePartBounds(part);
  return false;
}

function ensureInitialSheet() {
  if (sheetState.length > 0) return;
  sheetState.push(createSheetFrom());
  syncSheetsOrigins({ preservePartPositions: false });
  rebuildSheetsVisuals();
}

function setActiveSheet(index, { animate = false } = {}) {
  const idx = getValidSheetIndex(index);
  if (idx < 0) return;
  activeSheetIndex = idx;
  inactiveProxyDirty = true;
  if (animate) {
    startSheetRingTransition();
    updateSheetListUi();
    updateSheetInfoBadge();
    return;
  }
  syncSheetsOrigins({ preservePartPositions: true });
  rebuildSheetsVisuals();
  updateSheetListUi();
  updateSheetInfoBadge();
  updateGlobalBounds();
}

function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", onResize);
onResize();

transformControls.addEventListener("dragging-changed", (event) => {
  controls.enabled = !event.value;
  if (!event.value && selectedPart) {
    clampPartToSheet(selectedPart);
    updateSheetListUi();
  }
});

transformControls.addEventListener("objectChange", () => {
  if (selectedPart) {
    cachePartBounds(selectedPart);
    clampPartToSheet(selectedPart);
  }
  updateGlobalBounds();
  updateSheetListUi();
});

function disposeObject3D(root) {
  root.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (!node.material) return;

    if (Array.isArray(node.material)) {
      for (const mat of node.material) mat.dispose();
    } else {
      node.material.dispose();
    }
  });
}

function removePartFromScene(part) {
  if (!part) return false;
  if (selectedPart === part) clearSelection();
  partsGroup.remove(part);
  disposeObject3D(part);
  inactiveProxyDirty = true;
  return true;
}

function deleteSheetAt(index) {
  const idx = getValidSheetIndex(index);
  if (idx < 0) return false;

  clearSelection();

  const toRemove = [];
  for (const part of partsGroup.children) {
    const sheetIdx = Number(part.userData?.sheetIndex);
    if (!Number.isFinite(sheetIdx)) continue;
    const normalized = Math.trunc(sheetIdx);
    if (normalized === idx) {
      toRemove.push(part);
      continue;
    }
    if (normalized > idx) {
      part.userData.sheetIndex = normalized - 1;
    }
  }

  for (const part of toRemove) {
    partsGroup.remove(part);
    disposeObject3D(part);
  }

  sheetState.splice(idx, 1);
  inactiveProxyDirty = true;

  if (sheetState.length > 0) {
    activeSheetIndex = Math.min(idx, sheetState.length - 1);
    syncSheetsOrigins({ preservePartPositions: true });
  } else {
    activeSheetIndex = 0;
  }

  rebuildSheetsVisuals();
  updateGlobalBounds();
  updatePieceCountBadge();
  updateSheetListUi();
  updateSheetInfoBadge();
  return true;
}

function clearSelection() {
  transformControls.detach();

  if (selectionOutline) {
    if (selectionOutline.parent) selectionOutline.parent.remove(selectionOutline);
    const disposedMaterials = new Set();
    selectionOutline.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (!node.material) return;
      if (Array.isArray(node.material)) {
        for (const mat of node.material) {
          if (mat && !disposedMaterials.has(mat)) {
            mat.dispose();
            disposedMaterials.add(mat);
          }
        }
      } else if (!disposedMaterials.has(node.material)) {
        node.material.dispose();
        disposedMaterials.add(node.material);
      }
    });
    selectionOutline = null;
  }

  selectedPart = null;
  inactiveProxyDirty = true;
  updateSelectedPieceBadge(null);
  updateSheetInfoBadge();
}

function buildSelectionOutline(part) {
  const outline = new THREE.Group();
  outline.name = "__selectionOutline";
  outline.renderOrder = 1000;

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    toneMapped: false
  });

  const primaryLoop = part?.userData?.selectionPrimaryLoop;
  if (Array.isArray(primaryLoop) && primaryLoop.length >= 3) {
    const contour = primaryLoop
      .map((p) => new THREE.Vector3(Number(p?.x), Number(p?.y), 0))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (contour.length >= 3) {
      contour.push(contour[0].clone());
      const loopGeo = new THREE.BufferGeometry().setFromPoints(contour);
      const loopLine = new THREE.Line(loopGeo, lineMaterial);
      loopLine.raycast = () => {};
      outline.add(loopLine);
    }
  }

  if (outline.children.length > 0) return outline;

  part.traverse((node) => {
    if (!(node && node.isMesh && node.geometry)) return;
    const edgesGeo = new THREE.EdgesGeometry(node.geometry, 1);
    if (!edgesGeo || edgesGeo.attributes.position.count < 2) {
      if (edgesGeo) edgesGeo.dispose();
      return;
    }
    const edgeLines = new THREE.LineSegments(edgesGeo, lineMaterial);
    edgeLines.matrixAutoUpdate = false;
    edgeLines.matrix.copy(node.matrix);
    edgeLines.matrixWorldNeedsUpdate = true;
    edgeLines.raycast = () => {};
    outline.add(edgeLines);
  });

  if (outline.children.length === 0) {
    lineMaterial.dispose();
    return null;
  }
  return outline;
}

function setSelectedPart(part) {
  if (selectedPart === part) return;

  clearSelection();
  if (!part) return;

  selectedPart = part;
  transformControls.attach(selectedPart);
  updateSelectedPieceBadge(selectedPart);
  const partSheetIndex = getValidSheetIndex(selectedPart.userData?.sheetIndex);
  if (partSheetIndex >= 0 && partSheetIndex !== activeSheetIndex) {
    setActiveSheet(partSheetIndex, { animate: true });
  } else {
    updateSheetInfoBadge();
  }

  selectionOutline = buildSelectionOutline(selectedPart);
  if (selectionOutline) selectedPart.add(selectionOutline);
  inactiveProxyDirty = true;
}

function partFromIntersectionObject(object) {
  let current = object;
  while (current && current.parent) {
    if (current.parent === partsGroup) return current;
    current = current.parent;
  }
  return null;
}

function pickPartAtPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(partsGroup.children, true);

  if (hits.length === 0) {
    setSelectedPart(null);
    return;
  }

  const part = partFromIntersectionObject(hits[0].object);
  setSelectedPart(part);
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerDownX = event.clientX;
  pointerDownY = event.clientY;
  pointerMoved = false;
});

renderer.domElement.addEventListener("pointermove", (event) => {
  if (Math.abs(event.clientX - pointerDownX) > 3 || Math.abs(event.clientY - pointerDownY) > 3) {
    pointerMoved = true;
  }
});

renderer.domElement.addEventListener("pointerup", (event) => {
  if (pointerMoved) return;
  if (transformControls.dragging) return;
  if (transformControls.axis) return;
  pickPartAtPointer(event);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearSelection();
    return;
  }

  const isDelete = event.key === "Delete" || event.key === "Backspace";
  if (!isDelete) return;

  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  event.preventDefault();
  const sheetFocused = !!sheetListEl && sheetListEl.contains(document.activeElement);
  if (sheetFocused || !selectedPart) {
    deleteSheetAt(activeSheetIndex);
    return;
  }

  const part = selectedPart;
  if (!part) return;
  removePartFromScene(part);
  updateGlobalBounds();
  updatePieceCountBadge();
  updateSheetListUi();
  updateSheetInfoBadge();
});

// ---------------------------
// DXF -> 3D mesh
// Supports: LWPOLYLINE / POLYLINE / LINE+ARC loops / CIRCLE
// ---------------------------
function bulgeSegmentPoints(p1, p2, bulge, chordTol = 0.8) {
  if (!(p1 instanceof THREE.Vector2) || !(p2 instanceof THREE.Vector2)) return [];
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-12) return [p1.clone(), p2.clone()];

  const chord = p1.distanceTo(p2);
  if (chord < 1e-9) return [p1.clone(), p2.clone()];

  const theta = 4.0 * Math.atan(bulge);
  const sinHalf = Math.sin(Math.abs(theta) / 2.0);
  if (Math.abs(sinHalf) < 1e-12) return [p1.clone(), p2.clone()];

  const radius = chord / (2.0 * sinHalf);
  const midX = (p1.x + p2.x) * 0.5;
  const midY = (p1.y + p2.y) * 0.5;
  const normalX = -(p2.y - p1.y) / chord;
  const normalY = (p2.x - p1.x) / chord;
  const offset = Math.sqrt(Math.max(radius * radius - (chord * 0.5) ** 2, 0));
  const sign = bulge > 0 ? 1.0 : -1.0;
  const cx = midX + normalX * offset * sign;
  const cy = midY + normalY * offset * sign;
  const start = Math.atan2(p1.y - cy, p1.x - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * radius) / Math.max(chordTol, 0.05)));

  const pts = [p1.clone()];
  for (let i = 1; i <= steps; i += 1) {
    const a = start + theta * (i / steps);
    pts.push(new THREE.Vector2(
      cx + radius * Math.cos(a),
      cy + radius * Math.sin(a)
    ));
  }
  pts[pts.length - 1] = p2.clone();
  return pts;
}

function polylineVertices(entity) {
  const src = Array.isArray(entity?.vertices) ? entity.vertices : [];
  const out = [];
  for (const v of src) {
    const x = Number(v?.x);
    const y = Number(v?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const bulge = Number(v?.bulge || 0);
    out.push({
      point: new THREE.Vector2(x, y),
      bulge: Number.isFinite(bulge) ? bulge : 0
    });
  }
  return out;
}

function polylineToPoints(entity) {
  if (entity?.type !== "LWPOLYLINE" && entity?.type !== "POLYLINE") return null;

  const verts = polylineVertices(entity);
  if (verts.length < 2) return null;

  const closed = entity.type === "LWPOLYLINE"
    ? (!!entity.shape || !!entity.closed || isClosedByGeometry(verts.map((v) => v.point)))
    : (!!entity.closed || isClosedByGeometry(verts.map((v) => v.point)));

  const segCount = closed ? verts.length : verts.length - 1;
  const pts = [verts[0].point.clone()];
  for (let i = 0; i < segCount; i += 1) {
    const n = (i + 1) % verts.length;
    const segPts = bulgeSegmentPoints(verts[i].point, verts[n].point, verts[i].bulge, 0.8);
    for (let k = 1; k < segPts.length; k += 1) pts.push(segPts[k]);
  }
  if (closed && pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) <= 1e-6) pts.pop();
  return { pts, closed };
}

function lineToPoints(entity) {
  if (entity.type !== "LINE") return null;

  if (Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
    return {
      a: new THREE.Vector2(entity.vertices[0].x, entity.vertices[0].y),
      b: new THREE.Vector2(entity.vertices[1].x, entity.vertices[1].y)
    };
  }

  if (entity.start && entity.end) {
    return {
      a: new THREE.Vector2(entity.start.x, entity.start.y),
      b: new THREE.Vector2(entity.end.x, entity.end.y)
    };
  }

  return null;
}

function toRadiansFromDxfDegrees(angle) {
  if (!Number.isFinite(angle)) return NaN;
  return THREE.MathUtils.degToRad(angle);
}

function arcToPolylinePoints(entity, maxSagitta = 0.35) {
  if (entity.type !== "ARC" || !entity.center) return null;

  const radius = Number(entity.radius);
  let start = toRadiansFromDxfDegrees(Number(entity.startAngle));
  let end = toRadiansFromDxfDegrees(Number(entity.endAngle));

  if (!Number.isFinite(radius) || radius <= 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  while (end <= start) end += Math.PI * 2;
  const sweep = end - start;
  if (sweep <= 1e-9) return null;

  const center = new THREE.Vector2(entity.center.x, entity.center.y);
  const sagitta = Math.min(Math.max(maxSagitta, 0.05), radius * 0.5);
  const acosArg = THREE.MathUtils.clamp(1 - (sagitta / radius), -1, 1);
  const idealStepAngle = 2 * Math.acos(acosArg);
  const fallbackStepAngle = THREE.MathUtils.degToRad(3);
  const stepAngle = Number.isFinite(idealStepAngle) && idealStepAngle > 1e-6
    ? idealStepAngle
    : fallbackStepAngle;
  const steps = THREE.MathUtils.clamp(
    Math.ceil(sweep / stepAngle),
    6,
    2048
  );
  const pts = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = start + (sweep * t);
    pts.push(new THREE.Vector2(
      center.x + (Math.cos(a) * radius),
      center.y + (Math.sin(a) * radius)
    ));
  }

  return pts;
}

function splineToPolylinePoints(entity) {
  if (entity?.type !== "SPLINE") return null;

  const controlPoints = Array.isArray(entity.controlPoints) ? entity.controlPoints : [];
  const fitPoints = Array.isArray(entity.fitPoints) ? entity.fitPoints : [];
  const source = controlPoints.length >= 2 ? controlPoints : fitPoints;
  if (source.length < 2) return null;

  const pts = [];
  for (const raw of source) {
    const x = Number(raw?.x ?? raw?.[0]);
    const y = Number(raw?.y ?? raw?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const next = new THREE.Vector2(x, y);
    if (!pts.length || pts[pts.length - 1].distanceTo(next) > 1e-7) pts.push(next);
  }
  if (pts.length < 2) return null;

  const flags = Number(entity?.flags || 0);
  const closedByFlag = ((flags & 1) === 1);
  const closed = !!entity?.closed || !!entity?.isClosed || closedByFlag || isClosedByGeometry(pts);
  if (closed && pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) <= 1e-6) pts.pop();

  return { pts, closed };
}

function circleToShapeInfo(entity) {
  if (entity.type !== "CIRCLE" || !entity.center) return null;

  const radius = Number(entity.radius);
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const center = new THREE.Vector2(entity.center.x, entity.center.y);
  return { center, radius };
}

function isClosedByGeometry(pts, eps = 1e-6) {
  if (!pts || pts.length < 3) return false;
  return pts[0].distanceTo(pts[pts.length - 1]) <= eps;
}

function buildClosedPointList(pts) {
  const cleaned = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.distanceTo(p) > 1e-9) cleaned.push(p);
  }

  if (cleaned.length < 3) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first.distanceTo(last) > 1e-9) cleaned.push(first.clone());

  return cleaned;
}

function buildShapeInfoFromPoints(pts) {
  const closedPts = buildClosedPointList(pts);
  if (!closedPts) return null;

  return {
    shape: new THREE.Shape(closedPts),
    outline: closedPts
  };
}

function appendSegmentsFromPointList(pts, outSegments) {
  if (!Array.isArray(pts) || pts.length < 2 || !Array.isArray(outSegments)) return;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!(a instanceof THREE.Vector2) || !(b instanceof THREE.Vector2)) continue;
    if (a.distanceTo(b) <= 1e-9) continue;
    outSegments.push({ a, b });
  }
}

function parseNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function distArray(a, b) {
  const ax = Number(a?.[0]);
  const ay = Number(a?.[1]);
  const bx = Number(b?.[0]);
  const by = Number(b?.[1]);
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return Infinity;
  return Math.hypot(ax - bx, ay - by);
}

function arcPointsArray(center, radius, startDeg, endDeg, chordTol = 0.8) {
  if (radius <= 0) return [];
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360.0;
  const steps = Math.max(8, Math.ceil((Math.PI * sweep / 180.0 * radius) / Math.max(chordTol, 0.05)));
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (startDeg + sweep * (i / steps)) * Math.PI / 180.0;
    pts.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  return pts;
}

function bulgePointsArray(p1, p2, bulge, chordTol = 0.8) {
  if (Math.abs(bulge) < 1e-12) return [p1, p2];
  const chord = distArray(p1, p2);
  if (chord < EPS) return [p1, p2];
  const theta = 4.0 * Math.atan(bulge);
  const sinHalf = Math.sin(Math.abs(theta) / 2.0);
  if (Math.abs(sinHalf) < EPS) return [p1, p2];
  const radius = chord / (2.0 * sinHalf);
  const midX = (p1[0] + p2[0]) * 0.5;
  const midY = (p1[1] + p2[1]) * 0.5;
  const normalX = -(p2[1] - p1[1]) / chord;
  const normalY = (p2[0] - p1[0]) / chord;
  const offset = Math.sqrt(Math.max(radius * radius - (chord * 0.5) ** 2, 0));
  const sign = bulge > 0 ? 1.0 : -1.0;
  const cx = midX + normalX * offset * sign;
  const cy = midY + normalY * offset * sign;
  const start = Math.atan2(p1[1] - cy, p1[0] - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) * radius) / Math.max(chordTol, 0.05)));
  const pts = [p1];
  for (let i = 1; i <= steps; i += 1) {
    const a = start + theta * (i / steps);
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  pts[pts.length - 1] = p2;
  return pts;
}

function contourPolylineLengthArray(points, closed = false) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i += 1) len += distArray(points[i - 1], points[i]);
  if (closed && points.length > 2) len += distArray(points[points.length - 1], points[0]);
  return len;
}

function contourBoundsArray(points) {
  if (!Array.isArray(points) || points.length < 1) return null;
  let minX = Number(points[0]?.[0]);
  let minY = Number(points[0]?.[1]);
  let maxX = minX;
  let maxY = minY;
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  for (const p of points) {
    const x = Number(p?.[0]);
    const y = Number(p?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function bboxesNearArray(a, b, gap) {
  if (!a || !b) return false;
  const g = Number.isFinite(gap) ? gap : 0;
  return !(
    a.maxX + g < b.minX ||
    b.maxX + g < a.minX ||
    a.maxY + g < b.minY ||
    b.maxY + g < a.minY
  );
}

function compactLoopPointsArray(points, tol) {
  const out = [];
  for (const raw of (points || [])) {
    const px = Number(raw && raw[0]);
    const py = Number(raw && raw[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    if (!out.length || distArray(out[out.length - 1], [px, py]) > tol) {
      out.push([px, py]);
    }
  }
  if (out.length > 1 && distArray(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

function cleanImportedContoursCnc(contours) {
  const cleaned = [];
  for (const contour of (contours || [])) {
    const rawPts = contour?.points || [];
    const pts = [];
    for (const raw of rawPts) {
      const x = Number(raw && raw[0]);
      const y = Number(raw && raw[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!pts.length || distArray(pts[pts.length - 1], [x, y]) > 1e-5) {
        pts.push([x, y]);
      }
    }
    const closed = !!contour?.closed;
    if (closed && pts.length > 2 && distArray(pts[0], pts[pts.length - 1]) <= 1e-5) pts.pop();
    const minPts = closed ? 3 : 2;
    if (pts.length < minPts) continue;
    const len = contourPolylineLengthArray(pts, closed);
    if (!Number.isFinite(len) || len <= 0.10) continue;
    cleaned.push({ points: pts, closed });
  }
  if (cleaned.length < 2) return cleaned;

  function stitchContoursForContinuity(inputContours, joinTol, closeTol) {
    const out = [];
    const openPool = [];
    const dedupTol = Math.max(1e-5, Math.min(joinTol * 0.35, 0.08));

    for (const contour of (inputContours || [])) {
      const pts = compactLoopPointsArray((contour?.points || []), dedupTol);
      if (pts.length < 2) continue;
      let closed = !!contour?.closed;
      if (!closed && pts.length >= 3 && distArray(pts[0], pts[pts.length - 1]) <= closeTol) closed = true;
      if (closed) {
        if (pts.length > 2 && distArray(pts[0], pts[pts.length - 1]) <= closeTol) pts.pop();
        if (pts.length >= 3) out.push({ points: pts, closed: true });
      } else {
        openPool.push(pts);
      }
    }

    while (openPool.length > 0) {
      let chain = openPool.pop();
      let grew = true;
      while (grew) {
        grew = false;
        const cStart = chain[0];
        const cEnd = chain[chain.length - 1];
        let best = null;
        for (let i = 0; i < openPool.length; i += 1) {
          const pts = openPool[i];
          if (!pts || pts.length < 2) continue;
          const pStart = pts[0];
          const pEnd = pts[pts.length - 1];
          const options = [
            { d: distArray(cEnd, pStart), attachEnd: true, reverse: false, idx: i },
            { d: distArray(cEnd, pEnd), attachEnd: true, reverse: true, idx: i },
            { d: distArray(cStart, pEnd), attachEnd: false, reverse: false, idx: i },
            { d: distArray(cStart, pStart), attachEnd: false, reverse: true, idx: i },
          ];
          for (const opt of options) {
            if (opt.d > joinTol) continue;
            if (!best || opt.d < best.d) best = opt;
          }
        }
        if (!best) break;
        const picked = openPool.splice(best.idx, 1)[0];
        const seg = best.reverse ? [...picked].reverse() : [...picked];
        if (best.attachEnd) {
          if (seg.length && distArray(chain[chain.length - 1], seg[0]) <= joinTol) seg.shift();
          chain = chain.concat(seg);
        } else {
          if (seg.length && distArray(seg[seg.length - 1], chain[0]) <= joinTol) seg.pop();
          chain = seg.concat(chain);
        }
        grew = true;
      }
      const closed = chain.length >= 3 && distArray(chain[0], chain[chain.length - 1]) <= closeTol;
      if (closed) chain.pop();
      if (chain.length >= (closed ? 3 : 2)) out.push({ points: chain, closed });
    }
    return out;
  }

  const bounds = cleaned.map((c) => contourBoundsArray(c.points));
  let minX = 1e30;
  let minY = 1e30;
  let maxX = -1e30;
  let maxY = -1e30;
  for (const b of bounds) {
    if (!b) continue;
    minX = Math.min(minX, Number(b.minX));
    minY = Math.min(minY, Number(b.minY));
    maxX = Math.max(maxX, Number(b.maxX));
    maxY = Math.max(maxY, Number(b.maxY));
  }
  if (!(maxX > minX + EPS && maxY > minY + EPS)) return cleaned;
  const spanW = maxX - minX;
  const spanH = maxY - minY;
  const minSide = Math.max(1.0, Math.min(spanW, spanH));
  const stitchJoin = Math.max(0.03, Math.min(0.45, minSide * 0.0018));
  const stitchClose = Math.max(stitchJoin * 1.35, 0.05);
  const stitched = stitchContoursForContinuity(cleaned, stitchJoin, stitchClose);
  const merged = stitched.length ? stitched : cleaned;
  if (merged.length < 2) return merged;

  const mBounds = merged.map((c) => contourBoundsArray(c.points));
  minX = 1e30;
  minY = 1e30;
  maxX = -1e30;
  maxY = -1e30;
  for (const b of mBounds) {
    if (!b) continue;
    minX = Math.min(minX, Number(b.minX));
    minY = Math.min(minY, Number(b.minY));
    maxX = Math.max(maxX, Number(b.maxX));
    maxY = Math.max(maxY, Number(b.maxY));
  }
  if (!(maxX > minX + EPS && maxY > minY + EPS)) return merged;
  const mSpanW = maxX - minX;
  const mSpanH = maxY - minY;
  const mMinSide = Math.max(1.0, Math.min(mSpanW, mSpanH));
  const joinGap = Math.max(0.5, Math.min(20.0, mMinSide * 0.05));

  const used = new Array(merged.length).fill(false);
  const groups = [];
  for (let i = 0; i < merged.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const stack = [i];
    const idxs = [];
    let gMinX = 1e30;
    let gMinY = 1e30;
    let gMaxX = -1e30;
    let gMaxY = -1e30;
    let totalLen = 0.0;

    while (stack.length) {
      const idx = stack.pop();
      idxs.push(idx);
      const b = mBounds[idx];
      const c = merged[idx];
      totalLen += contourPolylineLengthArray(c.points, c.closed);
      gMinX = Math.min(gMinX, Number(b.minX));
      gMinY = Math.min(gMinY, Number(b.minY));
      gMaxX = Math.max(gMaxX, Number(b.maxX));
      gMaxY = Math.max(gMaxY, Number(b.maxY));

      for (let j = 0; j < merged.length; j += 1) {
        if (used[j]) continue;
        if (!bboxesNearArray(mBounds[idx], mBounds[j], joinGap)) continue;
        used[j] = true;
        stack.push(j);
      }
    }
    const area = Math.max(EPS, (gMaxX - gMinX) * (gMaxY - gMinY));
    groups.push({ idxs, area, score: totalLen * Math.sqrt(area) });
  }
  if (groups.length < 2) return merged;
  groups.sort((a, b) => Number(b.score) - Number(a.score));
  const main = groups[0];
  const alt = groups[1];
  const areaAll = Math.max(EPS, mSpanW * mSpanH);
  const keepOnlyMain = (
    (Number(main.score) > Number(alt.score) * 2.4 && Number(main.area) > Number(alt.area) * 1.8) ||
    (areaAll > Number(main.area) * 1.45 && Number(main.score) > Number(alt.score) * 1.6)
  );
  if (!keepOnlyMain) return merged;
  return main.idxs.map((idx) => merged[idx]);
}

function normalizeContoursCnc(contours) {
  const filtered = cleanImportedContoursCnc(contours);
  const all = [];
  for (const c of filtered) for (const p of (c.points || [])) all.push(p);
  if (!all.length) return null;
  let minX = all[0][0];
  let minY = all[0][1];
  let maxX = all[0][0];
  let maxY = all[0][1];
  for (const p of all) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const shifted = filtered.map((c) => ({
    closed: !!c.closed,
    points: (c.points || []).map((p) => [p[0] - minX, p[1] - minY]),
  }));
  return {
    contours: shifted,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function normalizeContoursSimple(contours) {
  const valid = [];
  for (const contour of (contours || [])) {
    const pts = [];
    for (const p of (contour?.points || [])) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    const closed = !!contour?.closed && pts.length >= 3;
    valid.push({ points: pts, closed });
  }
  if (!valid.length) return null;

  const all = [];
  for (const c of valid) for (const p of (c.points || [])) all.push(p);
  if (!all.length) return null;
  let minX = all[0][0];
  let minY = all[0][1];
  let maxX = all[0][0];
  let maxY = all[0][1];
  for (const p of all) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }

  return {
    contours: valid.map((c) => ({
      closed: !!c.closed,
      points: c.points.map((p) => [p[0] - minX, p[1] - minY]),
    })),
    width: maxX - minX,
    height: maxY - minY,
  };
}

function entityField(fields, code, fallback = "") {
  for (const item of fields) {
    if (item[0] === code) return item[1];
  }
  return fallback;
}

function readRecord(pairs, start) {
  const type = String(pairs[start][1] || "").toUpperCase();
  let i = start + 1;
  const fields = [];
  while (i < pairs.length && pairs[i][0] !== "0") {
    fields.push(pairs[i]);
    i += 1;
  }
  return { type, fields, next: i };
}

function parseDxfAsciiCnc(text, options = {}) {
  const preferSimple = !!options.preferSimple;
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([lines[i].trim(), lines[i + 1].trim()]);
  }
  let inEntities = false;
  let i = 0;
  const contours = [];

  while (i < pairs.length) {
    const code = pairs[i][0];
    const value = String(pairs[i][1] || "").toUpperCase();
    if (code === "0" && value === "SECTION") {
      const next = pairs[i + 1];
      if (next && next[0] === "2" && String(next[1] || "").toUpperCase() === "ENTITIES") {
        inEntities = true;
      }
      i += 1;
      continue;
    }
    if (!inEntities) {
      i += 1;
      continue;
    }
    if (code !== "0") {
      i += 1;
      continue;
    }
    if (value === "ENDSEC") {
      inEntities = false;
      i += 1;
      continue;
    }

    if (value === "POLYLINE") {
      const poly = readRecord(pairs, i);
      const closed = (parseInt(entityField(poly.fields, "70", "0"), 10) & 1) === 1;
      const vertices = [];
      let j = poly.next;
      while (j < pairs.length) {
        if (pairs[j][0] !== "0") {
          j += 1;
          continue;
        }
        const rec = readRecord(pairs, j);
        if (rec.type === "VERTEX") {
          vertices.push({
            x: parseNum(entityField(rec.fields, "10", "0")),
            y: parseNum(entityField(rec.fields, "20", "0")),
            bulge: parseNum(entityField(rec.fields, "42", "0")),
          });
          j = rec.next;
          continue;
        }
        if (rec.type === "SEQEND") {
          j = rec.next;
          break;
        }
        break;
      }
      if (vertices.length >= 2) {
        const segCount = closed ? vertices.length : vertices.length - 1;
        const pts = [[vertices[0].x, vertices[0].y]];
        for (let k = 0; k < segCount; k += 1) {
          const n = (k + 1) % vertices.length;
          const p1 = [vertices[k].x, vertices[k].y];
          const p2 = [vertices[n].x, vertices[n].y];
          const segPts = bulgePointsArray(p1, p2, vertices[k].bulge, 0.8);
          for (let s = 1; s < segPts.length; s += 1) pts.push(segPts[s]);
        }
        if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
        contours.push({ points: pts, closed });
      }
      i = j;
      continue;
    }

    const rec = readRecord(pairs, i);
    if (value === "LINE") {
      const x1 = parseNum(entityField(rec.fields, "10", "0"));
      const y1 = parseNum(entityField(rec.fields, "20", "0"));
      const x2 = parseNum(entityField(rec.fields, "11", "0"));
      const y2 = parseNum(entityField(rec.fields, "21", "0"));
      contours.push({ points: [[x1, y1], [x2, y2]], closed: false });
    } else if (value === "ARC") {
      const cx = parseNum(entityField(rec.fields, "10", "0"));
      const cy = parseNum(entityField(rec.fields, "20", "0"));
      const radius = parseNum(entityField(rec.fields, "40", "0"));
      const startA = parseNum(entityField(rec.fields, "50", "0"));
      const endA = parseNum(entityField(rec.fields, "51", "0"));
      const pts = arcPointsArray([cx, cy], radius, startA, endA, 0.8);
      if (pts.length > 1) contours.push({ points: pts, closed: false });
    } else if (value === "CIRCLE") {
      const cx = parseNum(entityField(rec.fields, "10", "0"));
      const cy = parseNum(entityField(rec.fields, "20", "0"));
      const radius = parseNum(entityField(rec.fields, "40", "0"));
      const pts = arcPointsArray([cx, cy], radius, 0.0, 360.0, 0.8);
      if (pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
      if (pts.length >= 3) contours.push({ points: pts, closed: true });
    } else if (value === "LWPOLYLINE") {
      const closed = (parseInt(entityField(rec.fields, "70", "0"), 10) & 1) === 1;
      const vertices = [];
      let current = null;
      for (const f of rec.fields) {
        if (f[0] === "10") {
          if (current) vertices.push(current);
          current = { x: parseNum(f[1]), y: 0.0, bulge: 0.0 };
        } else if (f[0] === "20" && current) {
          current.y = parseNum(f[1]);
        } else if (f[0] === "42" && current) {
          current.bulge = parseNum(f[1]);
        }
      }
      if (current) vertices.push(current);
      if (vertices.length >= 2) {
        const segCount = closed ? vertices.length : vertices.length - 1;
        const pts = [[vertices[0].x, vertices[0].y]];
        for (let k = 0; k < segCount; k += 1) {
          const n = (k + 1) % vertices.length;
          const p1 = [vertices[k].x, vertices[k].y];
          const p2 = [vertices[n].x, vertices[n].y];
          const segPts = bulgePointsArray(p1, p2, vertices[k].bulge, 0.8);
          for (let s = 1; s < segPts.length; s += 1) pts.push(segPts[s]);
        }
        if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
        contours.push({ points: pts, closed });
      }
    } else if (value === "SPLINE") {
      const closed = (parseInt(entityField(rec.fields, "70", "0"), 10) & 1) === 1;
      const controlPoints = [];
      const fitPoints = [];
      let currentControl = null;
      let currentFit = null;

      for (const f of rec.fields) {
        if (f[0] === "10") {
          if (currentControl) controlPoints.push(currentControl);
          currentControl = [parseNum(f[1]), 0.0];
        } else if (f[0] === "20" && currentControl) {
          currentControl[1] = parseNum(f[1]);
        } else if (f[0] === "11") {
          if (currentFit) fitPoints.push(currentFit);
          currentFit = [parseNum(f[1]), 0.0];
        } else if (f[0] === "21" && currentFit) {
          currentFit[1] = parseNum(f[1]);
        }
      }
      if (currentControl) controlPoints.push(currentControl);
      if (currentFit) fitPoints.push(currentFit);

      const source = controlPoints.length >= 2 ? controlPoints : fitPoints;
      if (source.length >= 2) {
        const pts = [];
        for (const p of source) {
          const x = parseNum(p[0]);
          const y = parseNum(p[1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (!pts.length || distArray(pts[pts.length - 1], [x, y]) > 1e-7) {
            pts.push([x, y]);
          }
        }
        if (pts.length >= 2) {
          if (closed && pts.length > 1 && distArray(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
          contours.push({ points: pts, closed });
        }
      }
    }
    i = rec.next;
  }

  if (preferSimple) {
    return normalizeContoursSimple(contours) || normalizeContoursCnc(contours);
  }
  return normalizeContoursCnc(contours) || normalizeContoursSimple(contours);
}

function pointKey(point, eps = 1e-4) {
  return `${Math.round(point.x / eps)}_${Math.round(point.y / eps)}`;
}

function extractClosedLoopsFromSegments(segments, eps = 1e-4) {
  const edges = [];
  const adjacency = new Map();

  function addAdj(key, edgeIndex) {
    const list = adjacency.get(key);
    if (list) list.push(edgeIndex);
    else adjacency.set(key, [edgeIndex]);
  }

  for (const seg of segments) {
    if (!seg || !seg.a || !seg.b) continue;
    if (seg.a.distanceTo(seg.b) <= 1e-9) continue;

    const aKey = pointKey(seg.a, eps);
    const bKey = pointKey(seg.b, eps);
    if (aKey === bKey) continue;

    const edgeIndex = edges.length;
    edges.push({ a: seg.a, b: seg.b, aKey, bKey });
    addAdj(aKey, edgeIndex);
    addAdj(bKey, edgeIndex);
  }

  const used = new Array(edges.length).fill(false);
  const loops = [];

  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;

    used[i] = true;
    const firstEdge = edges[i];
    const startKey = firstEdge.aKey;
    let prevKey = firstEdge.aKey;
    let currentKey = firstEdge.bKey;
    const path = [firstEdge.a.clone(), firstEdge.b.clone()];
    let closed = currentKey === startKey;

    for (let guard = 0; !closed && guard < edges.length + 2; guard++) {
      const candidates = (adjacency.get(currentKey) || []).filter((idx) => !used[idx]);
      if (candidates.length === 0) break;

      let nextEdgeIndex = candidates[0];
      if (candidates.length > 1) {
        const preferred = candidates.find((idx) => {
          const e = edges[idx];
          const nextKey = e.aKey === currentKey ? e.bKey : e.aKey;
          return nextKey !== prevKey;
        });
        if (preferred !== undefined) nextEdgeIndex = preferred;
      }

      used[nextEdgeIndex] = true;
      const nextEdge = edges[nextEdgeIndex];
      const nextKey = nextEdge.aKey === currentKey ? nextEdge.bKey : nextEdge.aKey;
      const nextPoint = nextEdge.aKey === currentKey ? nextEdge.b : nextEdge.a;

      path.push(nextPoint.clone());
      prevKey = currentKey;
      currentKey = nextKey;
      closed = currentKey === startKey;
    }

    if (closed && path.length >= 3) loops.push(path);
  }

  return loops;
}

function compactLoopPoints(points, tol) {
  const out = [];
  for (const raw of (points || [])) {
    if (!(raw instanceof THREE.Vector2)) continue;
    if (!out.length || out[out.length - 1].distanceTo(raw) > tol) {
      out.push(raw.clone());
    }
  }
  if (out.length > 1 && out[0].distanceTo(out[out.length - 1]) <= tol) out.pop();
  return out;
}

function stitchClosedLoopsFromOpenContours(openContours, tol) {
  const dedupTol = Math.max(1e-5, Math.min(0.08, Number(tol || 0) * 0.05));
  const pool = [];
  for (const contour of (openContours || [])) {
    const pts = compactLoopPoints(contour, dedupTol);
    if (pts.length >= 2) pool.push({ points: pts, used: false });
  }
  const loops = [];

  for (let baseIdx = 0; baseIdx < pool.length; baseIdx += 1) {
    if (pool[baseIdx].used) continue;
    pool[baseIdx].used = true;
    let chain = [...pool[baseIdx].points];

    while (true) {
      if (chain.length >= 3 && chain[0].distanceTo(chain[chain.length - 1]) <= tol) break;

      const start = chain[0];
      const end = chain[chain.length - 1];
      let best = null;

      for (let i = 0; i < pool.length; i += 1) {
        const item = pool[i];
        if (item.used) continue;
        const pts = item.points;
        if (pts.length < 2) continue;
        const a = pts[0];
        const b = pts[pts.length - 1];

        const candidates = [
          { d: end.distanceTo(a), prepend: false, reverse: false },
          { d: end.distanceTo(b), prepend: false, reverse: true },
          { d: start.distanceTo(b), prepend: true, reverse: false },
          { d: start.distanceTo(a), prepend: true, reverse: true },
        ];
        for (const c of candidates) {
          if (c.d > tol) continue;
          if (!best || c.d < best.d) {
            best = { idx: i, d: c.d, prepend: c.prepend, reverse: c.reverse };
          }
        }
      }

      if (!best) break;
      const pick = pool[best.idx];
      pick.used = true;
      let pts = pick.points;
      if (best.reverse) pts = [...pts].reverse();

      if (best.prepend) {
        const add = [...pts];
        if (add.length && add[add.length - 1].distanceTo(chain[0]) <= tol) add.pop();
        chain = add.concat(chain);
      } else {
        const add = [...pts];
        if (add.length && chain[chain.length - 1].distanceTo(add[0]) <= tol) add.shift();
        chain = chain.concat(add);
      }
    }

    const loop = compactLoopPoints(chain, dedupTol);
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

function findDominantOuterLoopFromOpenContours(openContours, sourceArea, minSideHint = 0) {
  if (!Array.isArray(openContours) || openContours.length < 2) return null;
  if (!(Number(sourceArea) > EPS)) return null;

  const safeMinSide = Number.isFinite(minSideHint) && minSideHint > 0
    ? minSideHint
    : Math.sqrt(sourceArea);

  const tolSet = new Set([
    0.6, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20
  ]);
  for (const raw of [
    safeMinSide * 0.004,
    safeMinSide * 0.006,
    safeMinSide * 0.008,
    safeMinSide * 0.012,
    safeMinSide * 0.016,
    safeMinSide * 0.02,
    safeMinSide * 0.03
  ]) {
    const tol = Number(raw);
    if (!Number.isFinite(tol) || tol <= 0) continue;
    tolSet.add(Math.min(20, Math.max(0.6, Number(tol.toFixed(3)))));
  }

  const tolerances = [...tolSet].sort((a, b) => a - b);
  let bestLoop = null;
  let bestArea = 0;

  for (const tol of tolerances) {
    const loops = stitchClosedLoopsFromOpenContours(openContours, tol);
    for (const loop of loops) {
      const closedPts = buildClosedPointList(loop);
      if (!closedPts || closedPts.length < 4) continue;
      const openPts = closedPts.slice(0, -1);
      const area = Math.abs(polygonAreaSigned(openPts));
      if (!(area > bestArea + 1e-8)) continue;
      if (area > sourceArea * 1.2) continue;
      bestArea = area;
      bestLoop = openPts.map((p) => p.clone());
    }
    if (bestArea >= sourceArea * 0.75) break;
  }

  if (!(bestArea >= sourceArea * 0.45)) return null;
  return bestLoop;
}

function polygonAreaSigned(openPts) {
  if (!Array.isArray(openPts) || openPts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < openPts.length; i += 1) {
    const a = openPts[i];
    const b = openPts[(i + 1) % openPts.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area * 0.5;
}

function pointOnSegment(point, a, b, eps = 1e-8) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const cross = Math.abs(abx * apy - aby * apx);
  if (cross > eps) return false;
  const dot = (apx * abx) + (apy * aby);
  if (dot < -eps) return false;
  const lenSq = (abx * abx) + (aby * aby);
  if (dot - lenSq > eps) return false;
  return true;
}

function pointInPolygonStrict(point, closedPts) {
  if (!closedPts || closedPts.length < 4) return false;
  for (let i = 0; i < closedPts.length - 1; i += 1) {
    if (pointOnSegment(point, closedPts[i], closedPts[i + 1])) return false;
  }

  let inside = false;
  const count = closedPts.length - 1;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const pi = closedPts[i];
    const pj = closedPts[j];
    const intersect =
      ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || Number.EPSILON) + pi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

function bboxContainsPoint(bbox, point, eps = 1e-6) {
  return (
    point.x >= bbox.minX - eps &&
    point.x <= bbox.maxX + eps &&
    point.y >= bbox.minY - eps &&
    point.y <= bbox.maxY + eps
  );
}

function polygonCentroid(openPts) {
  if (!Array.isArray(openPts) || openPts.length < 3) return null;
  let areaAcc = 0;
  let cxAcc = 0;
  let cyAcc = 0;
  for (let i = 0; i < openPts.length; i += 1) {
    const a = openPts[i];
    const b = openPts[(i + 1) % openPts.length];
    const cross = (a.x * b.y) - (b.x * a.y);
    areaAcc += cross;
    cxAcc += (a.x + b.x) * cross;
    cyAcc += (a.y + b.y) * cross;
  }
  const area = areaAcc * 0.5;
  if (Math.abs(area) <= 1e-9) return null;
  return new THREE.Vector2(cxAcc / (6 * area), cyAcc / (6 * area));
}

function pickSampleInside(openPts, closedPts) {
  const candidates = [];
  const centroid = polygonCentroid(openPts);
  if (centroid) candidates.push(centroid);

  let sx = 0;
  let sy = 0;
  for (const p of openPts) {
    sx += p.x;
    sy += p.y;
  }
  if (openPts.length) candidates.push(new THREE.Vector2(sx / openPts.length, sy / openPts.length));
  if (openPts.length >= 2) {
    candidates.push(new THREE.Vector2(
      (openPts[0].x + openPts[1].x) * 0.5,
      (openPts[0].y + openPts[1].y) * 0.5
    ));
  }
  if (openPts.length) candidates.push(openPts[0].clone());

  for (const candidate of candidates) {
    if (pointInPolygonStrict(candidate, closedPts)) return candidate;
  }
  return candidates[candidates.length - 1] || new THREE.Vector2(0, 0);
}

function orientLoop(points, clockwise) {
  const copy = [...points];
  if (copy.length < 3) return [];
  const isClockwise = polygonAreaSigned(copy) < 0;
  if ((clockwise && !isClockwise) || (!clockwise && isClockwise)) {
    copy.reverse();
  }
  return copy;
}

function convexHullFromPoints(points) {
  const pts = (points || [])
    .map((p) => new THREE.Vector2(Number(p?.x), Number(p?.y)))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return [];

  const cross = (o, a, b) => ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : [];
}

function circleToLoopPoints(center, radius, segments = 72) {
  if (!(Number.isFinite(segments) && segments >= 6)) {
    const sagitta = Math.min(Math.max(0.35, 0.05), Math.max(radius, 0.1) * 0.5);
    const acosArg = THREE.MathUtils.clamp(1 - (sagitta / Math.max(radius, 1e-6)), -1, 1);
    const stepAngle = Math.max(THREE.MathUtils.degToRad(5), 2 * Math.acos(acosArg));
    segments = THREE.MathUtils.clamp(Math.ceil((Math.PI * 2) / stepAngle), 12, 96);
  }
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector2(
      center.x + Math.cos(a) * radius,
      center.y + Math.sin(a) * radius
    ));
  }
  return pts;
}

function choosePrimarySelectionLoop(closedLoops, allPoints) {
  let bestLoop = null;
  let bestArea = 0;
  let sourceBounds = null;
  let sourceArea = 0;

  if (Array.isArray(allPoints) && allPoints.length >= 3) {
    sourceBounds = computePointCloudBounds(allPoints);
    sourceArea = Number(sourceBounds?.area || 0);
  }

  for (const loop of (closedLoops || [])) {
    if (!Array.isArray(loop) || loop.length < 3) continue;
    const area = Math.abs(polygonAreaSigned(loop));
    if (!(area > bestArea + 1e-8)) continue;
    bestArea = area;
    bestLoop = loop;
  }

  if (bestLoop && bestLoop.length >= 3) {
    return bestLoop.map((p) => new THREE.Vector2(Number(p?.x), Number(p?.y)))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  if (bestLoop && sourceArea > 1e-8) {
    const ratio = bestArea / sourceArea;
    // Avoid selecting thin border-strip loops as primary outline.
    if (ratio < 0.35) {
      const hullFallback = convexHullFromPoints(allPoints || []);
      if (Array.isArray(hullFallback) && hullFallback.length >= 3) return hullFallback;
    }
  }

  const hull = convexHullFromPoints(allPoints || []);
  if (Array.isArray(hull) && hull.length >= 3) return hull;
  return null;
}

function assignSelectionOutlineData(localGroup, closedLoops, allPoints) {
  if (!localGroup) return;
  const loop = choosePrimarySelectionLoop(closedLoops, allPoints);
  if (!loop || loop.length < 3) {
    delete localGroup.userData.selectionPrimaryLoop;
    return;
  }
  localGroup.userData.selectionPrimaryLoop = loop.map((p) => new THREE.Vector2(p.x, p.y));
}

function assignSelectionOutlineDataFromShapes(localGroup, shapes, closedLoops, allPoints) {
  if (!localGroup) return;

  let bestLoop = null;
  let bestArea = 0;
  for (const shape of (shapes || [])) {
    if (!shape || typeof shape.getPoints !== "function") continue;
    const pts = shape.getPoints(320)
      .map((p) => new THREE.Vector2(Number(p?.x), Number(p?.y)))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 3) continue;
    if (pts[0].distanceTo(pts[pts.length - 1]) <= 1e-9) pts.pop();
    if (pts.length < 3) continue;

    const area = Math.abs(polygonAreaSigned(pts));
    if (!(area > bestArea + 1e-8)) continue;
    bestArea = area;
    bestLoop = pts;
  }

  if (bestLoop && bestLoop.length >= 3) {
    localGroup.userData.selectionPrimaryLoop = bestLoop.map((p) => new THREE.Vector2(p.x, p.y));
    return;
  }

  assignSelectionOutlineData(localGroup, closedLoops, allPoints);
}

function computePointCloudBounds(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!pts.length) return null;

  let minX = pts[0].x;
  let minY = pts[0].y;
  let maxX = pts[0].x;
  let maxY = pts[0].y;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    area: Math.max(1e-8, width * height)
  };
}

function shouldForceHullFromTinyClosedLoops(closedLoops, sourceArea, openEntityCount, stitchedLoopCount) {
  if (!(Number(sourceArea) > 1e-8)) return false;
  if (Number(openEntityCount) < 2) return false;
  if (Number(stitchedLoopCount) < 2) return false;
  if (!Array.isArray(closedLoops) || closedLoops.length < 4) return false;

  const tinyAreaThreshold = sourceArea * 0.0035;
  const largeAreaThreshold = sourceArea * 0.02;
  let validLoopCount = 0;
  let tinyCount = 0;
  let largeCount = 0;

  for (const loop of closedLoops) {
    if (!Array.isArray(loop) || loop.length < 3) continue;
    const area = Math.abs(polygonAreaSigned(loop));
    if (!(area > 1e-8)) continue;
    validLoopCount += 1;
    if (area <= tinyAreaThreshold) tinyCount += 1;
    if (area >= largeAreaThreshold) largeCount += 1;
  }

  if (validLoopCount < 4) return false;
  if (largeCount > 0) return false;
  return tinyCount >= Math.min(6, validLoopCount);
}

function collectTinyClosedLoops(closedLoops, sourceArea) {
  if (!Array.isArray(closedLoops) || !(Number(sourceArea) > 1e-8)) return [];
  const tinyAreaThreshold = sourceArea * 0.0035;
  const out = [];
  for (const loop of closedLoops) {
    if (!Array.isArray(loop) || loop.length < 3) continue;
    const area = Math.abs(polygonAreaSigned(loop));
    if (!(area > 1e-8) || area > tinyAreaThreshold) continue;
    out.push(loop.map((p) => new THREE.Vector2(Number(p?.x), Number(p?.y))));
  }
  return out;
}

function buildShapesFromClosedLoops(closedLoops, allPoints, options = {}) {
  const allowHullFallback = options.allowHullFallback !== false;
  const forceHullFromTinyClosed = !!options.forceHullFromTinyClosed;
  function splitCompoundLoopCandidates(openPts) {
    if (!Array.isArray(openPts) || openPts.length < 4) return [openPts];

    let minX = openPts[0].x;
    let minY = openPts[0].y;
    let maxX = openPts[0].x;
    let maxY = openPts[0].y;
    let hasRepeatKey = false;
    const seen = new Map();
    const repeatTol = 1e-4;

    for (let i = 0; i < openPts.length; i += 1) {
      const p = openPts[i];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);

      const key = pointKey(p, repeatTol);
      const prev = seen.get(key);
      const isNonAdjacentRepeat = prev !== undefined && (i - prev > 1);
      if (isNonAdjacentRepeat) hasRepeatKey = true;
      if (prev === undefined) seen.set(key, i);
    }

    const areaAbs = Math.abs(polygonAreaSigned(openPts));
    const bboxArea = Math.max(EPS, (maxX - minX) * (maxY - minY));
    const areaRatio = areaAbs / bboxArea;
    const suspicious = hasRepeatKey || areaRatio > 1.08 || areaRatio < 0.42;
    if (!suspicious) return [openPts];

    const segs = [];
    const seq = [...openPts, openPts[0]];
    appendSegmentsFromPointList(seq, segs);
    let subLoops = extractClosedLoopsFromSegments(segs, 1e-4);
    if (subLoops.length < 2) subLoops = extractClosedLoopsFromSegments(segs, 5e-4);
    if (subLoops.length < 2) return [openPts];

    const candidates = [];
    for (const loopPts of subLoops) {
      const shapeInfo = buildShapeInfoFromPoints(loopPts);
      if (!shapeInfo) continue;
      const loopOpen = shapeInfo.outline.slice(0, -1);
      if (loopOpen.length < 3) continue;
      const loopArea = Math.abs(polygonAreaSigned(loopOpen));
      if (!(loopArea > 1e-8)) continue;

      let lx0 = loopOpen[0].x;
      let ly0 = loopOpen[0].y;
      let lx1 = loopOpen[0].x;
      let ly1 = loopOpen[0].y;
      for (const p of loopOpen) {
        lx0 = Math.min(lx0, p.x);
        ly0 = Math.min(ly0, p.y);
        lx1 = Math.max(lx1, p.x);
        ly1 = Math.max(ly1, p.y);
      }
      const w = Math.max(EPS, lx1 - lx0);
      const h = Math.max(EPS, ly1 - ly0);
      candidates.push({
        loopOpen,
        area: loopArea,
        cx: (lx0 + lx1) * 0.5,
        cy: (ly0 + ly1) * 0.5,
        minDim: Math.min(w, h)
      });
    }
    if (!candidates.length) return [openPts];

    const minDimMedian = [...candidates]
      .map((x) => x.minDim)
      .sort((a, b) => a - b)[Math.floor(candidates.length * 0.5)];
    const quant = Math.max(1e-4, Math.min(0.5, minDimMedian * 0.15));

    // Some DXFs encode the same hole as concentric/stacked loops in one path.
    // Keep only one loop per hole center (largest area) to avoid fake filled patches.
    const bestByCenter = new Map();
    for (const c of candidates) {
      const key = `${Math.round(c.cx / quant)}_${Math.round(c.cy / quant)}`;
      const prev = bestByCenter.get(key);
      if (!prev || c.area > prev.area) bestByCenter.set(key, c);
    }

    const normalized = [...bestByCenter.values()]
      .sort((a, b) => b.area - a.area)
      .map((x) => x.loopOpen);
    return normalized.length ? normalized : [openPts];
  }

  function makeLoopRecord(openPts, bboxHint = null) {
    if (!Array.isArray(openPts) || openPts.length < 3) return null;
    const areaAbs = Math.abs(polygonAreaSigned(openPts));
    if (!(areaAbs > 1e-8)) return null;

    let minX;
    let minY;
    let maxX;
    let maxY;

    if (bboxHint) {
      minX = Number(bboxHint.minX);
      minY = Number(bboxHint.minY);
      maxX = Number(bboxHint.maxX);
      maxY = Number(bboxHint.maxY);
    } else {
      minX = openPts[0].x;
      minY = openPts[0].y;
      maxX = openPts[0].x;
      maxY = openPts[0].y;
      for (const p of openPts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const closedPts = buildClosedPointList(openPts);
    if (!closedPts || closedPts.length < 4) return null;

    return {
      openPts,
      closedPts,
      areaAbs,
      bbox: { minX, minY, maxX, maxY },
      sample: pickSampleInside(openPts, closedPts),
      parent: -1,
      depth: -1
    };
  }

  const loops = [];
  for (const loop of (closedLoops || [])) {
    const closedPts = buildClosedPointList(loop);
    if (!closedPts || closedPts.length < 4) continue;
    const openPts = closedPts.slice(0, -1);
    const loopCandidates = splitCompoundLoopCandidates(openPts);
    for (const candidate of loopCandidates) {
      const rec = makeLoopRecord(candidate);
      if (rec) loops.push(rec);
    }
  }
  if (!loops.length) return [];

  const sourcePts = (allPoints || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  let sourceMinX = 0;
  let sourceMinY = 0;
  let sourceMaxX = 0;
  let sourceMaxY = 0;
  let sourceBBoxArea = 0;
  let hasSourceBBox = false;

  if (sourcePts.length >= 3) {
    sourceMinX = sourcePts[0].x;
    sourceMinY = sourcePts[0].y;
    sourceMaxX = sourcePts[0].x;
    sourceMaxY = sourcePts[0].y;
    for (const p of sourcePts) {
      sourceMinX = Math.min(sourceMinX, p.x);
      sourceMinY = Math.min(sourceMinY, p.y);
      sourceMaxX = Math.max(sourceMaxX, p.x);
      sourceMaxY = Math.max(sourceMaxY, p.y);
    }
    sourceBBoxArea = Math.max(1e-8, (sourceMaxX - sourceMinX) * (sourceMaxY - sourceMinY));
    hasSourceBBox = true;
  }

  if (forceHullFromTinyClosed && hasSourceBBox && sourcePts.length >= 3) {
    const tinyThreshold = sourceBBoxArea * 0.0035;
    const tinyLoops = loops.filter((x) => x.areaAbs <= tinyThreshold);
    const hull = convexHullFromPoints(sourcePts);
    const normalized = tinyLoops.map((x) => ({
      openPts: x.openPts,
      closedPts: x.closedPts,
      areaAbs: x.areaAbs,
      bbox: x.bbox,
      sample: x.sample,
      parent: -1,
      depth: -1
    }));
    const hullRec = makeLoopRecord(hull, {
      minX: sourceMinX, minY: sourceMinY, maxX: sourceMaxX, maxY: sourceMaxY
    });
    if (hullRec) normalized.push(hullRec);

    if (normalized.length >= 1) {
      loops.length = 0;
      loops.push(...normalized);
    }
  }

  if (allowHullFallback && sourcePts.length >= 3) {
    const bboxArea = sourceBBoxArea;
    const maxLoopArea = Math.max(...loops.map((x) => x.areaAbs));
    const hasLikelyOuter = loops.some((x) => x.areaAbs > bboxArea * 0.05);
    let hasStrongContainerContour = false;
    if (loops.length >= 2) {
      let outerIdx = 0;
      let secondArea = 0;
      for (let i = 1; i < loops.length; i += 1) {
        if (loops[i].areaAbs > loops[outerIdx].areaAbs) outerIdx = i;
      }
      for (let i = 0; i < loops.length; i += 1) {
        if (i === outerIdx) continue;
        secondArea = Math.max(secondArea, loops[i].areaAbs);
      }

      let insideCount = 0;
      const outer = loops[outerIdx];
      for (let i = 0; i < loops.length; i += 1) {
        if (i === outerIdx) continue;
        const loop = loops[i];
        if (!bboxContainsPoint(outer.bbox, loop.sample, 1e-4)) continue;
        if (!pointInPolygonStrict(loop.sample, outer.closedPts)) continue;
        insideCount += 1;
      }

      const requiredInside = Math.max(1, Math.min(3, loops.length - 1));
      hasStrongContainerContour =
        insideCount >= requiredInside &&
        outer.areaAbs >= Math.max(secondArea * 6.0, bboxArea * 0.002);
    }

    const shouldAddHull =
      !hasLikelyOuter &&
      (
        !(maxLoopArea > bboxArea * 0.01) ||
        !hasStrongContainerContour
      );

    if (shouldAddHull) {
      const hull = convexHullFromPoints(sourcePts);
      if (hull.length >= 3) {
        const rec = makeLoopRecord(hull, {
          minX: sourceMinX, minY: sourceMinY, maxX: sourceMaxX, maxY: sourceMaxY
        });
        if (rec) loops.push(rec);
      }
    }
  }

  function tryBuildDensePerforatedPanelShape() {
    if (!hasSourceBBox) return null;
    if (loops.length < 220) return null;

    let outerIdx = -1;
    let outerArea = 0;
    for (let i = 0; i < loops.length; i += 1) {
      if (loops[i].areaAbs > outerArea) {
        outerArea = loops[i].areaAbs;
        outerIdx = i;
      }
    }
    if (outerIdx < 0) return null;
    if (outerArea < sourceBBoxArea * 0.30) return null;

    const outer = loops[outerIdx];
    const candidates = [];
    for (let i = 0; i < loops.length; i += 1) {
      if (i === outerIdx) continue;
      const loop = loops[i];
      if (!(loop.areaAbs > 1e-8)) continue;
      if (loop.areaAbs > sourceBBoxArea * 0.02) continue;
      if (!bboxContainsPoint(outer.bbox, loop.sample, 1e-4)) continue;
      if (!pointInPolygonStrict(loop.sample, outer.closedPts)) continue;
      candidates.push(loop);
    }
    if (candidates.length < 120) return null;

    const minDims = candidates
      .map((l) => Math.min(
        Math.max(EPS, Number(l.bbox.maxX) - Number(l.bbox.minX)),
        Math.max(EPS, Number(l.bbox.maxY) - Number(l.bbox.minY))
      ))
      .filter((d) => Number.isFinite(d) && d > EPS)
      .sort((a, b) => a - b);
    if (!minDims.length) return null;
    const medianDim = minDims[Math.floor(minDims.length * 0.5)];
    // Keep center dedupe very strict: only collapse truly duplicated loops
    // (same hole represented twice), not neighboring holes in dense grids.
    const quant = Math.max(1e-4, Math.min(0.25, medianDim * 0.03));

    const bestByCell = new Map();
    for (const loop of candidates) {
      const cx = (Number(loop.bbox.minX) + Number(loop.bbox.maxX)) * 0.5;
      const cy = (Number(loop.bbox.minY) + Number(loop.bbox.maxY)) * 0.5;
      const key = `${Math.round(cx / quant)}_${Math.round(cy / quant)}`;
      const prev = bestByCell.get(key);
      if (!prev || loop.areaAbs > prev.areaAbs) bestByCell.set(key, loop);
    }

    const dedupHoles = [...bestByCell.values()];
    if (dedupHoles.length < 90) return null;

    const shape = new THREE.Shape(orientLoop(outer.openPts, false));
    for (const hole of dedupHoles) {
      const holePts = orientLoop(hole.openPts, true);
      if (holePts.length < 3) continue;
      shape.holes.push(new THREE.Path(holePts));
    }
    return [shape];
  }

  const densePanelShapes = tryBuildDensePerforatedPanelShape();
  if (densePanelShapes && densePanelShapes.length > 0) return densePanelShapes;

  function buildDepthAndChildrenFromParents() {
    for (const loop of loops) loop.depth = -1;

    function resolveDepth(idx) {
      if (loops[idx].depth >= 0) return loops[idx].depth;
      const parent = loops[idx].parent;
      loops[idx].depth = parent < 0 ? 0 : resolveDepth(parent) + 1;
      return loops[idx].depth;
    }
    for (let i = 0; i < loops.length; i += 1) resolveDepth(i);

    const childrenByParent = new Map();
    for (let i = 0; i < loops.length; i += 1) {
      const parent = loops[i].parent;
      if (parent < 0) continue;
      const list = childrenByParent.get(parent) || [];
      list.push(i);
      childrenByParent.set(parent, list);
    }
    return childrenByParent;
  }

  function computeLoopHierarchy() {
    for (const loop of loops) {
      loop.parent = -1;
      loop.depth = -1;
    }

    for (let i = 0; i < loops.length; i += 1) {
      const loop = loops[i];
      let bestParent = -1;
      for (let j = 0; j < loops.length; j += 1) {
        if (i === j) continue;
        const candidate = loops[j];
        if (!(candidate.areaAbs > loop.areaAbs + 1e-8)) continue;
        if (!bboxContainsPoint(candidate.bbox, loop.sample)) continue;
        if (!pointInPolygonStrict(loop.sample, candidate.closedPts)) continue;
        if (bestParent === -1 || candidate.areaAbs < loops[bestParent].areaAbs) bestParent = j;
      }
      loop.parent = bestParent;
    }

    return buildDepthAndChildrenFromParents();
  }

  let childrenByParent = computeLoopHierarchy();

  if (hasSourceBBox && sourcePts.length >= 3) {
    const rootIdx = [];
    for (let i = 0; i < loops.length; i += 1) {
      if (loops[i].parent < 0) rootIdx.push(i);
    }

    if (rootIdx.length >= 3) {
      const sourceW = Math.max(EPS, sourceMaxX - sourceMinX);
      const sourceH = Math.max(EPS, sourceMaxY - sourceMinY);
      const borderTol = Math.max(4.0, Math.min(sourceW, sourceH) * 0.06);
      let borderTouchCount = 0;
      for (const idx of rootIdx) {
        const b = loops[idx].bbox;
        const minInset = Math.min(
          b.minX - sourceMinX,
          sourceMaxX - b.maxX,
          b.minY - sourceMinY,
          sourceMaxY - b.maxY
        );
        if (minInset <= borderTol) borderTouchCount += 1;
      }

      const rootAreas = rootIdx
        .map((idx) => loops[idx].areaAbs)
        .sort((a, b) => b - a);
      const tinyThreshold = sourceBBoxArea * 0.002;
      const tinyLoops = loops.filter((x) => x.areaAbs <= tinyThreshold);

      const looksFragmentedSheet =
        borderTouchCount >= 3 &&
        tinyLoops.length >= 6 &&
        rootAreas.length >= 3 &&
        rootAreas[0] < sourceBBoxArea * 0.45;

      if (looksFragmentedSheet) {
        const hull = convexHullFromPoints(sourcePts);
        const normalized = tinyLoops.map((t) => ({
          openPts: t.openPts,
          closedPts: t.closedPts,
          areaAbs: t.areaAbs,
          bbox: t.bbox,
          sample: t.sample,
          parent: -1,
          depth: -1
        }));
        const hullRec = makeLoopRecord(hull, {
          minX: sourceMinX, minY: sourceMinY, maxX: sourceMaxX, maxY: sourceMaxY
        });
        if (hullRec) normalized.push(hullRec);

        if (normalized.length >= 2) {
          loops.length = 0;
          loops.push(...normalized);
          childrenByParent = computeLoopHierarchy();
        }
      }
    }
  }

  const pseudoHoleSkipSet = new Set();
  const descendantCountCache = new Map();
  function countDescendants(idx) {
    if (descendantCountCache.has(idx)) return descendantCountCache.get(idx);
    const children = childrenByParent.get(idx) || [];
    let total = children.length;
    for (const childIdx of children) total += countDescendants(childIdx);
    descendantCountCache.set(idx, total);
    return total;
  }

  function shouldSkipAsPseudoHole(parentLoop, parentIdx, childLoop, childIdx) {
    const parentArea = Math.max(EPS, Number(parentLoop?.areaAbs || 0));
    const childArea = Math.max(0, Number(childLoop?.areaAbs || 0));
    const areaRatio = childArea / parentArea;
    if (!(areaRatio > 0.70)) return false;

    const siblings = (childrenByParent.get(parentIdx) || []).filter((idx) => idx !== childIdx);
    let tinySiblingCount = 0;
    for (const idx of siblings) {
      const sibArea = Math.max(0, Number(loops[idx]?.areaAbs || 0));
      if ((sibArea / parentArea) < 0.02) tinySiblingCount += 1;
    }

    // Common CNC export pattern for sheet parts:
    // a large inner offset contour plus many tiny drilling loops.
    // The large inner contour is a duplicated border, not a true cutout.
    if (areaRatio > 0.68 && tinySiblingCount >= 6) return true;

    const parentW = Math.max(EPS, Number(parentLoop?.bbox?.maxX) - Number(parentLoop?.bbox?.minX));
    const parentH = Math.max(EPS, Number(parentLoop?.bbox?.maxY) - Number(parentLoop?.bbox?.minY));
    const insetLeft = Number(childLoop?.bbox?.minX) - Number(parentLoop?.bbox?.minX);
    const insetRight = Number(parentLoop?.bbox?.maxX) - Number(childLoop?.bbox?.maxX);
    const insetBottom = Number(childLoop?.bbox?.minY) - Number(parentLoop?.bbox?.minY);
    const insetTop = Number(parentLoop?.bbox?.maxY) - Number(childLoop?.bbox?.maxY);
    const minInset = Math.min(insetLeft, insetRight, insetBottom, insetTop);
    if (!(minInset >= -1e-4)) return false;

    const nearBorderTol = Math.max(4.0, Math.min(parentW, parentH) * 0.06);
    if (!(minInset <= nearBorderTol)) return false;

    // Large inset loops with many descendants are usually duplicated borders,
    // not real cutouts (common in some BricsCAD exports).
    if (countDescendants(childIdx) >= 6) return true;

    if (tinySiblingCount >= 8) return true;
    if (areaRatio > 0.82 && tinySiblingCount >= 4) return true;
    return false;
  }

  function normalizePseudoHoleContainers() {
    let changed = false;
    for (let parentIdx = 0; parentIdx < loops.length; parentIdx += 1) {
      const parentLoop = loops[parentIdx];
      if (parentLoop.depth % 2 !== 0) continue;

      const children = [...(childrenByParent.get(parentIdx) || [])];
      for (const childIdx of children) {
        if (pseudoHoleSkipSet.has(childIdx)) continue;
        const childLoop = loops[childIdx];
        if (childLoop.depth % 2 !== 1) continue;
        if (!shouldSkipAsPseudoHole(parentLoop, parentIdx, childLoop, childIdx)) continue;

        pseudoHoleSkipSet.add(childIdx);
        const grandChildren = childrenByParent.get(childIdx) || [];
        if (!grandChildren.length) continue;

        // Flatten duplicated container contours: keep descendants and reattach
        // them to the real parent so true slots/holes preserve odd depth.
        for (const grandIdx of grandChildren) loops[grandIdx].parent = parentIdx;
        loops[childIdx].parent = -1;
        changed = true;
      }
    }
    if (changed) {
      descendantCountCache.clear();
      childrenByParent = buildDepthAndChildrenFromParents();
    }
    return changed;
  }

  for (let guard = 0; guard < 8; guard += 1) {
    if (!normalizePseudoHoleContainers()) break;
  }

  function shouldSkipNestedIsland(idx) {
    const loop = loops[idx];
    if (!loop || loop.depth < 2 || (loop.depth % 2) !== 0) return false;
    if (!hasSourceBBox || !(sourceBBoxArea > EPS)) return false;

    const parentIdx = loop.parent;
    if (!(parentIdx >= 0)) return false;
    const parent = loops[parentIdx];
    if (!parent || (parent.depth % 2) !== 1) return false;

    const loopArea = Math.max(0, Number(loop.areaAbs || 0));
    const parentArea = Math.max(EPS, Number(parent.areaAbs || 0));
    const areaRatio = loopArea / parentArea;
    if (!(areaRatio > 0.20 && areaRatio < 0.98)) return false;

    const tinyLoop = loopArea <= sourceBBoxArea * 0.01;
    const tinyParent = parentArea <= sourceBBoxArea * 0.02;
    if (!(tinyLoop && tinyParent)) return false;

    const parentCx = (Number(parent.bbox.maxX) + Number(parent.bbox.minX)) * 0.5;
    const parentCy = (Number(parent.bbox.maxY) + Number(parent.bbox.minY)) * 0.5;
    const childCx = (Number(loop.bbox.maxX) + Number(loop.bbox.minX)) * 0.5;
    const childCy = (Number(loop.bbox.maxY) + Number(loop.bbox.minY)) * 0.5;
    const centerDist = Math.hypot(childCx - parentCx, childCy - parentCy);
    const parentW = Math.max(EPS, Number(parent.bbox.maxX) - Number(parent.bbox.minX));
    const parentH = Math.max(EPS, Number(parent.bbox.maxY) - Number(parent.bbox.minY));
    const centerTol = Math.max(0.6, Math.min(parentW, parentH) * 0.22);
    if (centerDist > centerTol) return false;

    return true;
  }

  const shapes = [];
  const shapeMetas = [];
  for (let i = 0; i < loops.length; i += 1) {
    const loop = loops[i];
    if (pseudoHoleSkipSet.has(i)) continue;
    if (loop.depth % 2 !== 0) continue;
    if (shouldSkipNestedIsland(i)) continue;
    const outerPts = orientLoop(loop.openPts, false);
    if (outerPts.length < 3) continue;
    const shape = new THREE.Shape(outerPts);

    const children = childrenByParent.get(i) || [];
    for (const childIdx of children) {
      if (pseudoHoleSkipSet.has(childIdx)) continue;
      const child = loops[childIdx];
      if (child.depth % 2 !== 1) continue;
      const holePts = orientLoop(child.openPts, true);
      if (holePts.length < 3) continue;
      shape.holes.push(new THREE.Path(holePts));
    }
    shapes.push(shape);
    shapeMetas.push({
      loopIdx: i,
      area: loop.areaAbs,
      holeCount: shape.holes.length,
      sample: loop.sample,
      bbox: loop.bbox
    });
  }

  function bboxArea2D(bbox) {
    if (!bbox) return 0;
    const w = Math.max(0, Number(bbox.maxX) - Number(bbox.minX));
    const h = Math.max(0, Number(bbox.maxY) - Number(bbox.minY));
    return w * h;
  }

  function bboxIntersectionArea2D(a, b) {
    if (!a || !b) return 0;
    const minX = Math.max(Number(a.minX), Number(b.minX));
    const minY = Math.max(Number(a.minY), Number(b.minY));
    const maxX = Math.min(Number(a.maxX), Number(b.maxX));
    const maxY = Math.min(Number(a.maxY), Number(b.maxY));
    if (!(maxX > minX) || !(maxY > minY)) return 0;
    return (maxX - minX) * (maxY - minY);
  }

  if (shapes.length > 1 && hasSourceBBox) {
    let dominantMetaIdx = -1;
    let dominantArea = 0;
    for (let i = 0; i < shapeMetas.length; i += 1) {
      if (shapeMetas[i].area > dominantArea) {
        dominantArea = shapeMetas[i].area;
        dominantMetaIdx = i;
      }
    }

    if (dominantMetaIdx >= 0) {
      const dominant = shapeMetas[dominantMetaIdx];
      const dominantLoop = loops[dominant.loopIdx];
      const densePerforatedPattern =
        dominant.holeCount >= 80 &&
        dominant.area >= sourceBBoxArea * 0.35;

      if (densePerforatedPattern && dominantLoop?.closedPts) {
        const dominantDensity = dominant.holeCount / Math.max(EPS, dominant.area);
        const dominantBBox = dominant.bbox || dominantLoop.bbox;
        const filteredShapes = [];
        const filteredMetas = [];
        for (let i = 0; i < shapes.length; i += 1) {
          if (i === dominantMetaIdx) {
            filteredShapes.push(shapes[i]);
            filteredMetas.push(shapeMetas[i]);
            continue;
          }

          const meta = shapeMetas[i];
          const insideDominant = pointInPolygonStrict(meta.sample, dominantLoop.closedPts);
          const areaRatio = meta.area / Math.max(EPS, dominant.area);
          const holeDensity = meta.holeCount / Math.max(EPS, meta.area);
          const densityRatio = holeDensity / Math.max(EPS, dominantDensity);
          const selfBBoxArea = bboxArea2D(meta.bbox);
          const overlapRatio = selfBBoxArea > EPS
            ? (bboxIntersectionArea2D(meta.bbox, dominantBBox) / selfBBoxArea)
            : 0;
          const looksArtifactOverlay =
            insideDominant &&
            areaRatio >= 0.04 &&
            areaRatio <= 0.98 &&
            (
              meta.holeCount <= 2 ||
              densityRatio < 0.35
            ) &&
            (
              areaRatio >= 0.16 ||
              overlapRatio >= 0.45 ||
              meta.holeCount <= 1
            );

          if (!looksArtifactOverlay) {
            filteredShapes.push(shapes[i]);
            filteredMetas.push(meta);
          }
        }

        // For heavily perforated plates, any additional interior solid islands
        // are usually duplicated export artifacts. Keep only the dominant shape.
        const secondary = filteredMetas.filter((meta) => meta.loopIdx !== dominant.loopIdx);
        const allSecondaryInsideDominant = secondary.every((meta) =>
          pointInPolygonStrict(meta.sample, dominantLoop.closedPts)
        );
        const hasLargeLowDensityOverlay = secondary.some((meta) => {
          const areaRatio = meta.area / Math.max(EPS, dominant.area);
          const holeDensity = meta.holeCount / Math.max(EPS, meta.area);
          const densityRatio = holeDensity / Math.max(EPS, dominantDensity);
          return areaRatio >= 0.10 && densityRatio < 0.45;
        });
        if (
          allSecondaryInsideDominant &&
          hasLargeLowDensityOverlay &&
          dominant.holeCount >= 160
        ) {
          return [shapes[dominantMetaIdx]];
        }

        if (filteredShapes.length === 1 && dominant.holeCount >= 80) {
          return filteredShapes;
        }
        return filteredShapes.length > 0 ? filteredShapes : [shapes[dominantMetaIdx]];
      }
    }
  }

  return shapes;
}

function importWithCncContours(dxfText, filename, thickness, material, localGroup, onIssue = null, preParsed = null) {
  let parsed = preParsed;
  if (!parsed) {
    try {
      parsed = parseDxfAsciiCnc(dxfText);
    } catch (error) {
      console.warn("Falha no parser ASCII CNC para:", filename, error);
      return false;
    }
  }
  let rawLineArcMode = false;
  if (shouldReparseInRawLineArcMode(parsed)) {
    try {
      const rawParsed = parseDxfAsciiCnc(dxfText, { preferSimple: true });
      if (rawParsed?.contours?.length > 0) {
        parsed = rawParsed;
        rawLineArcMode = true;
      }
    } catch (error) {
      console.warn("Falha no reparse raw LINE/ARC para:", filename, error);
    }
  }
  if (!parsed || !Array.isArray(parsed.contours) || parsed.contours.length < 1) return false;
  if (!(Number(parsed.width) > EPS && Number(parsed.height) > EPS)) return false;

  const closedLoops = [];
  const declaredClosedLoops = [];
  const allPoints = [];
  const segments = [];
  const fallbackOpenShapes = [];
  const openContours = [];

  for (const contour of parsed.contours) {
    const pts = (contour?.points || [])
      .map((pt) => new THREE.Vector2(Number(pt?.[0]), Number(pt?.[1])))
      .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (pts.length < 2) continue;
    allPoints.push(...pts);

    if (contour.closed) {
      const shapeInfo = buildShapeInfoFromPoints(pts);
      if (shapeInfo) {
        const loopOpen = shapeInfo.outline.slice(0, -1);
        closedLoops.push(loopOpen);
        declaredClosedLoops.push(loopOpen);
      }
    } else {
      openContours.push(pts);
      appendSegmentsFromPointList(pts, segments);
      const shapeInfo = buildShapeInfoFromPoints(pts);
      if (shapeInfo) fallbackOpenShapes.push(shapeInfo.shape);
    }
  }

  let segmentLoops = extractClosedLoopsFromSegments(segments, 1e-4);
  if (segmentLoops.length === 0 && segments.length > 0) {
    segmentLoops = extractClosedLoopsFromSegments(segments, 1e-2);
  }
  if (segmentLoops.length === 0 && segments.length > 0) {
    segmentLoops = extractClosedLoopsFromSegments(segments, 5e-2);
  }
  if (segmentLoops.length === 0 && openContours.length > 0) {
    const minSide = Math.max(1.0, Math.min(Number(parsed.width), Number(parsed.height)));
    const stitchTol = Math.max(0.05, Math.min(0.6, minSide * 0.005));
    segmentLoops = stitchClosedLoopsFromOpenContours(openContours, stitchTol);
  }

  const sourceArea = Math.max(EPS, Number(parsed.width) * Number(parsed.height));
  let forceHullFromTinyClosed = false;
  if (!rawLineArcMode) {
    forceHullFromTinyClosed = shouldForceHullFromTinyClosedLoops(
      declaredClosedLoops,
      sourceArea,
      openContours.length,
      segmentLoops.length
    );
  }
  let stitchedOuterLoop = null;
  if (forceHullFromTinyClosed) {
    const minSide = Math.max(1.0, Math.min(Number(parsed.width), Number(parsed.height)));
    stitchedOuterLoop = findDominantOuterLoopFromOpenContours(
      openContours,
      sourceArea,
      minSide
    );
    if (stitchedOuterLoop && stitchedOuterLoop.length >= 3) {
      forceHullFromTinyClosed = false;
    }
  }

  if (stitchedOuterLoop && stitchedOuterLoop.length >= 3) {
    const tinyLoops = collectTinyClosedLoops(declaredClosedLoops, sourceArea);
    closedLoops.length = 0;
    closedLoops.push(...tinyLoops, stitchedOuterLoop);
  } else {
    for (const loopPts of segmentLoops) {
      const shapeInfo = buildShapeInfoFromPoints(loopPts);
      if (shapeInfo) closedLoops.push(shapeInfo.outline.slice(0, -1));
    }
  }

  const closedShapes = buildShapesFromClosedLoops(
    closedLoops,
    allPoints,
    {
      allowHullFallback: true,
      forceHullFromTinyClosed
    }
  );
  assignSelectionOutlineDataFromShapes(localGroup, closedShapes, closedLoops, allPoints);
  for (const shape of closedShapes) {
    const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
    localGroup.add(mesh);
  }

  if (localGroup.children.length === 0 && fallbackOpenShapes.length > 0) {
    for (const shape of fallbackOpenShapes) {
      const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
      localGroup.add(mesh);
    }
    console.warn("Polylines abertas foram fechadas automaticamente em:", filename);
    reportImportIssue(
      onIssue,
      `Nenhuma entidade marcada como fechada em ${filename}. ` +
      "As polylines abertas foram fechadas automaticamente."
    );
  }

  return localGroup.children.length > 0;
}

function makeExtrudedMeshFromShape(shape, thickness, material) {
  const holeCount = Array.isArray(shape?.holes) ? shape.holes.length : 0;
  let curveSegments = 16;
  if (holeCount > 1200) curveSegments = 5;
  else if (holeCount > 700) curveSegments = 6;
  else if (holeCount > 350) curveSegments = 8;

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments,
    steps: 1
  });

  geo.translate(0, 0, -thickness / 2);
  geo.computeVertexNormals();

  return new THREE.Mesh(geo, material);
}

function reportImportIssue(onIssue, message) {
  if (typeof onIssue === "function") onIssue(message);
  else alert(message);
}

function shouldReparseInRawLineArcMode(parsed) {
  if (!parsed || !Array.isArray(parsed.contours) || parsed.contours.length < 3) return false;
  const sourceArea = Math.max(EPS, Number(parsed.width) * Number(parsed.height));
  if (!(sourceArea > EPS)) return false;

  let openCount = 0;
  let maxClosedArea = 0;
  for (const contour of parsed.contours) {
    const pts = (contour?.points || [])
      .map((pt) => new THREE.Vector2(Number(pt?.[0]), Number(pt?.[1])))
      .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (pts.length < 2) continue;
    if (!contour?.closed) {
      openCount += 1;
      continue;
    }
    if (pts.length < 3) continue;
    const area = Math.abs(polygonAreaSigned(pts));
    if (area > maxClosedArea) maxClosedArea = area;
  }

  // Typical LINE/ARC CNC plate export:
  // many open segments forming border + only tiny closed loops (holes).
  return openCount >= 2 && maxClosedArea < sourceArea * 0.02;
}

function finalizeImportedGroup(
  localGroup,
  autoCenter,
  {
    preferredSheetIndex = activeSheetIndex,
    allowCreateSheet = true,
    searchAllSheets = true,
    strictPlacement = false
  } = {}
) {
  if (!localGroup) return false;
  ensureInitialSheet();
  localGroup.updateMatrixWorld(true);
  tempBox.setFromObject(localGroup);
  if (autoCenter) {
    tempBox.getCenter(tempVec);
    localGroup.position.sub(tempVec);
  }

  const preferredIndex = getValidSheetIndex(preferredSheetIndex);
  const targetIndex = preferredIndex >= 0 ? preferredIndex : getValidSheetIndex(activeSheetIndex);
  const targetSheet = sheetState[targetIndex];
  setPartZForSheet(localGroup, targetSheet || { originZ: 0 });
  localGroup.userData.sheetIndex = targetIndex >= 0 ? targetIndex : 0;

  partsGroup.add(localGroup);
  cachePartBounds(localGroup);
  const placed = assignPartToSheet(localGroup, targetIndex, {
    allowCreateSheet,
    searchAllSheets
  });

  if (!placed && strictPlacement) {
    partsGroup.remove(localGroup);
    disposeObject3D(localGroup);
    return false;
  }

  if (!placed && !strictPlacement) {
    clampPartToSheet(localGroup);
  }

  const localBounds = cachePartBounds(localGroup);
  if (localBounds) {
    if (bboxAll.isEmpty()) bboxAll.copy(localBounds);
    else bboxAll.union(localBounds);
  } else {
    updateGlobalBounds();
  }
  updatePieceCountBadge();
  updateSheetListUi();
  updateSheetInfoBadge();
  return placed || !strictPlacement;
}

function addDxfToScene(
  dxfText,
  filename,
  thickness,
  autoCenter = true,
  onIssue = null,
  preParsed = null,
  onBuiltGroup = null,
  options = {}
) {
  const finalizeInScene = options?.finalizeInScene !== false;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.6, 0.55),
    metalness: 0.05,
    roughness: 0.85
  });

  const localGroup = new THREE.Group();
  localGroup.name = filename;
  markPartAsDxf(localGroup, thickness);

  // Prefer the CNC contour pipeline first (same logic used in the CNC flow).
  // It is lighter and handles many malformed/open contour cases better.
  try {
    const okCnc = importWithCncContours(
      dxfText,
      filename,
      thickness,
      material,
      localGroup,
      onIssue,
      preParsed
    );
    if (okCnc) {
      if (typeof onBuiltGroup === "function") onBuiltGroup(localGroup);
      return finalizeInScene ? finalizeImportedGroup(localGroup, autoCenter) : localGroup;
    }
  } catch (error) {
    console.warn("Fallback para parser DXF padrao em:", filename, error);
  }

  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    console.error("Erro ao parsear DXF:", filename, e);
    reportImportIssue(onIssue, `Erro ao parsear ${filename}. Veja o console (F12).`);
    return false;
  }

  const closedLoops = [];
  const declaredClosedLoops = [];
  const allPoints = [];
  const segments = [];
  const openContoursForStitch = [];
  const fallbackOpenShapes = [];
  const lineEntities = [];
  const arcEntities = [];
  const splineEntities = [];
  const entityTypeCount = new Map();

  for (const ent of (dxf.entities || [])) {
    const entityType = ent?.type || "UNKNOWN";
    entityTypeCount.set(entityType, (entityTypeCount.get(entityType) || 0) + 1);

    const circleInfo = circleToShapeInfo(ent);
    if (circleInfo) {
      const loopPts = circleToLoopPoints(circleInfo.center, circleInfo.radius);
      if (loopPts.length >= 3) {
        closedLoops.push(loopPts);
        declaredClosedLoops.push(loopPts);
        allPoints.push(...loopPts);
      }
      continue;
    }

    if (ent?.type === "LINE") {
      lineEntities.push(ent);
      continue;
    }

    if (ent?.type === "ARC") {
      arcEntities.push(ent);
      continue;
    }

    if (ent?.type === "SPLINE") {
      splineEntities.push(ent);
      continue;
    }

    const polyInfo = polylineToPoints(ent);
    if (!polyInfo) continue;
    allPoints.push(...polyInfo.pts);

    const shapeInfo = buildShapeInfoFromPoints(polyInfo.pts);
    if (!shapeInfo) continue;

    if (!polyInfo.closed) {
      openContoursForStitch.push(polyInfo.pts);
      appendSegmentsFromPointList(polyInfo.pts, segments);
      fallbackOpenShapes.push(shapeInfo.shape);
      continue;
    }

    const loopOpen = shapeInfo.outline.slice(0, -1);
    closedLoops.push(loopOpen);
    declaredClosedLoops.push(loopOpen);
  }

  for (const ent of lineEntities) {
    const seg = lineToPoints(ent);
    if (seg) {
      segments.push(seg);
      allPoints.push(seg.a, seg.b);
    }
  }

  for (const ent of arcEntities) {
    const arcPts = arcToPolylinePoints(ent);
    if (!arcPts || arcPts.length < 2) continue;
    allPoints.push(...arcPts);
    for (let i = 0; i < arcPts.length - 1; i++) {
      segments.push({ a: arcPts[i], b: arcPts[i + 1] });
    }
  }

  for (const ent of splineEntities) {
    const splineInfo = splineToPolylinePoints(ent);
    if (!splineInfo || splineInfo.pts.length < 2) continue;
    allPoints.push(...splineInfo.pts);

    if (splineInfo.closed) {
      const shapeInfo = buildShapeInfoFromPoints(splineInfo.pts);
      if (shapeInfo) {
        const loopOpen = shapeInfo.outline.slice(0, -1);
        closedLoops.push(loopOpen);
        declaredClosedLoops.push(loopOpen);
      }
      continue;
    }

    openContoursForStitch.push(splineInfo.pts);
    appendSegmentsFromPointList(splineInfo.pts, segments);
  }

  let segmentLoops = extractClosedLoopsFromSegments(segments, 1e-4);
  if (segmentLoops.length === 0 && segments.length > 0) {
    // Some DXFs have tiny endpoint gaps; retry with relaxed snapping.
    segmentLoops = extractClosedLoopsFromSegments(segments, 1e-2);
  }
  if (segmentLoops.length === 0 && segments.length > 0) {
    // Fallback adicional para DXF com gap maior entre segmentos de borda.
    segmentLoops = extractClosedLoopsFromSegments(segments, 5e-2);
  }
  if (segmentLoops.length === 0 && openContoursForStitch.length > 0) {
    const stitchTol = Math.max(0.05, Math.min(0.6, Math.sqrt(Math.max(1.0, allPoints.length)) * 0.03));
    segmentLoops = stitchClosedLoopsFromOpenContours(openContoursForStitch, stitchTol);
  }

  const sourceBounds = computePointCloudBounds(allPoints);
  const sourceArea = sourceBounds ? sourceBounds.area : 0;
  const openEntityCount = openContoursForStitch.length + lineEntities.length + arcEntities.length;
  let forceHullFromTinyClosed = shouldForceHullFromTinyClosedLoops(
    declaredClosedLoops,
    sourceArea,
    openEntityCount,
    segmentLoops.length
  );
  let stitchedOuterLoop = null;
  if (forceHullFromTinyClosed) {
    const minSide = sourceBounds ? Math.max(1.0, Math.min(sourceBounds.width, sourceBounds.height)) : 1.0;
    stitchedOuterLoop = findDominantOuterLoopFromOpenContours(
      openContoursForStitch,
      sourceArea,
      minSide
    );
    if (stitchedOuterLoop && stitchedOuterLoop.length >= 3) {
      forceHullFromTinyClosed = false;
    }
  }

  if (stitchedOuterLoop && stitchedOuterLoop.length >= 3) {
    const tinyLoops = collectTinyClosedLoops(declaredClosedLoops, sourceArea);
    closedLoops.length = 0;
    closedLoops.push(...tinyLoops, stitchedOuterLoop);
  } else {
    for (const loopPts of segmentLoops) {
      const shapeInfo = buildShapeInfoFromPoints(loopPts);
      if (shapeInfo) closedLoops.push(shapeInfo.outline.slice(0, -1));
    }
  }

  const closedShapes = buildShapesFromClosedLoops(
    closedLoops,
    allPoints,
    {
      allowHullFallback: true,
      forceHullFromTinyClosed
    }
  );
  assignSelectionOutlineDataFromShapes(localGroup, closedShapes, closedLoops, allPoints);

  for (const shape of closedShapes) {
    const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
    localGroup.add(mesh);
  }

  if (localGroup.children.length === 0 && fallbackOpenShapes.length > 0) {
    for (const shape of fallbackOpenShapes) {
      const mesh = makeExtrudedMeshFromShape(shape, thickness, material);
      localGroup.add(mesh);
    }

    console.warn("Polylines abertas foram fechadas automaticamente em:", filename);
    reportImportIssue(
      onIssue,
      `Nenhuma entidade marcada como fechada em ${filename}. ` +
      "As polylines abertas foram fechadas automaticamente."
    );
  }

  if (localGroup.children.length === 0) {
    const typesSummary = [...entityTypeCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");

    console.warn("Nenhuma entidade fechada encontrada em:", filename);
    if (typesSummary) console.warn("Tipos de entidade encontrados:", typesSummary);

    reportImportIssue(
      onIssue,
      `Nenhuma entidade fechada encontrada em ${filename}. ` +
      `Tipos no arquivo: ${typesSummary || "n/a"}. ` +
      "(Suporta LWPOLYLINE/POLYLINE, CIRCLE, SPLINE e loops de LINE/ARC)"
    );
    return false;
  }
  if (typeof onBuiltGroup === "function") onBuiltGroup(localGroup);
  return finalizeInScene ? finalizeImportedGroup(localGroup, autoCenter) : localGroup;
}

async function importSingleFileBrowserPipeline(
  file,
  thickness,
  autoCenter = true,
  onIssue = null,
  workerPool = null
) {
  let fileBuffer = null;
  let preParsed = null;

  try {
    fileBuffer = await file.arrayBuffer();
  } catch (decodeError) {
    console.error("Falha inesperada no decode:", file?.name, decodeError);
    reportImportIssue(onIssue, `Falha inesperada ao ler ${file?.name || "arquivo"}. Veja o console (F12).`);
    return false;
  }

  let text = "";
  try {
    text = decodeDxfArrayBuffer(fileBuffer, file?.name || "");
  } catch (decodeError) {
    console.error("Falha inesperada no decode:", file?.name, decodeError);
    reportImportIssue(onIssue, `Falha inesperada ao ler ${file?.name || "arquivo"}. Veja o console (F12).`);
    return false;
  }

  const pool = workerPool ?? getDxfWorkerPool();
  preParsed = pool ? await parseDxfWithWorkers(text, file?.name || "") : null;

  try {
    return addDxfToScene(
      text,
      file?.name || "arquivo.dxf",
      thickness,
      autoCenter,
      onIssue,
      preParsed
    );
  } catch (error) {
    console.error("Falha inesperada ao importar:", file?.name, error);
    reportImportIssue(onIssue, `Falha inesperada ao importar ${file?.name || "arquivo"}. Veja o console (F12).`);
    return false;
  }
}

function updateGlobalBounds() {
  bboxAll.makeEmpty();
  for (const sheetVisual of sheetsGroup.children) {
    sheetTempBox.setFromObject(sheetVisual);
    if (!sheetTempBox.isEmpty()) bboxAll.union(sheetTempBox);
  }
  for (const child of partsGroup.children) {
    const childBounds = getCachedPartBounds(child);
    if (!childBounds) continue;
    bboxAll.union(childBounds);
  }
}

function updateCameraDepthRange({
  maxDimension = 0,
  cameraDistance = 0
} = {}) {
  const maxDim = Math.max(1, Number(maxDimension || 0));
  const dist = Math.max(1, Number(cameraDistance || 0));
  const nearCandidate = THREE.MathUtils.clamp(dist / 420, CAMERA_NEAR_MIN, CAMERA_NEAR_MAX);
  const farCandidate = Math.max(
    nearCandidate + 4000,
    dist + maxDim * CAMERA_FAR_MARGIN
  );

  if (Math.abs(camera.near - nearCandidate) > 1e-3 || Math.abs(camera.far - farCandidate) > 1e-1) {
    camera.near = nearCandidate;
    camera.far = farCandidate;
    camera.updateProjectionMatrix();
  }
}

function fitToScene(padding = 1.25) {
  if (bboxAll.isEmpty()) return;

  const size = new THREE.Vector3();
  bboxAll.getSize(size);
  const center = new THREE.Vector3();
  bboxAll.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (maxDim / 2) / Math.tan(fov / 2);

  const dirVec = new THREE.Vector3(1, 1, 1).normalize();
  camera.position.copy(center.clone().add(dirVec.multiplyScalar(dist * padding)));
  updateCameraDepthRange({
    maxDimension: maxDim,
    cameraDistance: camera.position.distanceTo(center)
  });

  controls.target.copy(center);
  controls.update();
}

// ---------------------------
// UI
// ---------------------------
const fileInput = document.getElementById("fileInput");
const stepInput = document.getElementById("stepInput");
const fitBtn = document.getElementById("fitBtn");
const clearBtn = document.getElementById("clearBtn");
const pieceCountEl = document.getElementById("pieceCount");
const batchTimeEl = document.getElementById("batchTime");
const runtimeModeEl = document.getElementById("runtimeMode");
const cacheStatsEl = document.getElementById("cacheStats");
const selectedPieceEl = document.getElementById("selectedPiece");
const sheetInfoEl = document.getElementById("sheetInfo");
const sheetListEl = document.getElementById("sheetList");
const newSheetBtn = document.getElementById("newSheetBtn");
const editSheetBtn = document.getElementById("editSheetBtn");
const moveToSheetBtn = document.getElementById("moveToSheetBtn");
const sheetEditModalEl = document.getElementById("sheetEditModal");
const applySheetBtn = document.getElementById("applySheetBtn");
const applyAllSheetsBtn = document.getElementById("applyAllSheetsBtn");
const sheetWidthInput = document.getElementById("sheetW");
const sheetHeightInput = document.getElementById("sheetH");
const sheetThicknessInput = document.getElementById("sheetT");
const sheetMarginTopInput = document.getElementById("sheetMT");
const sheetMarginBottomInput = document.getElementById("sheetMB");
const sheetMarginLeftInput = document.getElementById("sheetML");
const sheetMarginRightInput = document.getElementById("sheetMR");
const sheetSpacingInput = document.getElementById("sheetS");
const inventoryListEl = document.getElementById("inventoryList");
const inventorySummaryEl = document.getElementById("inventorySummary");
const inventorySearchInput = document.getElementById("inventorySearch");
const inventoryTypeFilterEl = document.getElementById("inventoryTypeFilter");
const mountActiveSheetBtn = document.getElementById("mountActiveSheetBtn");
const mountAllSheetsBtn = document.getElementById("mountAllSheetsBtn");
const fpsBadgeEl = document.getElementById("fpsBadge");

if (runtimeModeEl) {
  runtimeModeEl.textContent = "Render: GPU (WebGL)";
}

let fpsFrameCounter = 0;
let fpsAccumMs = 0;
let fpsLastFrameTs = 0;
let fpsDisplayValue = 0;

function updateFpsBadgeText(fps = 0) {
  if (!fpsBadgeEl) return;
  const value = Number.isFinite(fps) ? Math.max(0, Math.round(fps)) : 0;
  fpsBadgeEl.textContent = `FPS: ${value}`;
}

function updatePieceCountBadge() {
  if (!pieceCountEl) return;
  pieceCountEl.textContent = `Pecas: ${partsGroup.children.length}`;
}

function updateBatchTimeBadge(ms) {
  if (!batchTimeEl) return;
  const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  batchTimeEl.textContent = `Tempo: ${value} ms`;
}

function updateCacheStatsBadge(stats = null) {
  if (!cacheStatsEl) return;
  if (!stats) {
    cacheStatsEl.textContent = "Cache: -";
    return;
  }

  const meshHits = Number(stats.meshHits || 0);
  const meshMisses = Number(stats.meshMisses || 0);
  const meshSaves = Number(stats.meshSaves || 0);
  const parseHits = Number(stats.parseHits || 0);
  const parseMisses = Number(stats.parseMisses || 0);
  const parseSaves = Number(stats.parseSaves || 0);
  const stepMeshHits = Number(stats.stepMeshHits || 0);
  const stepMeshMisses = Number(stats.stepMeshMisses || 0);
  const stepMeshSaves = Number(stats.stepMeshSaves || 0);
  const errors = Number(stats.errors || 0);
  const mode = String(stats.mode || "").trim();

  cacheStatsEl.textContent =
    `Cache DXF M:${meshHits}/${meshMisses}/${meshSaves} P:${parseHits}/${parseMisses}/${parseSaves}` +
    ` | STEP M:${stepMeshHits}/${stepMeshMisses}/${stepMeshSaves}` +
    (mode ? ` | Modo:${mode.toUpperCase()}` : "") +
    (errors > 0 ? ` ERR:${errors}` : "");
}

function extractPartCodeFromName(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) return "-";
  const fileName = raw.split(/[\\/]/).pop() || raw;
  const code = fileName.replace(/\.(dxf|step|stp)$/i, "").trim();
  return code || "-";
}

function formatInventoryTypeLabel(type) {
  return String(type || "").toLowerCase() === PART_KIND_DXF ? ".DXF" : ".STEP";
}

function formatInventorySizeLabel(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= EPS || h <= EPS) return "-";
  return `${w.toFixed(0)} x ${h.toFixed(0)} mm`;
}

function buildInventoryMergeKey(type, code) {
  return `${String(type || "").toLowerCase()}::${String(code || "").trim().toLowerCase()}`;
}

function hashStringFast(text) {
  const value = String(text || "");
  let hash = 2166136261;
  for (let idx = 0; idx < value.length; idx += 1) {
    hash ^= value.charCodeAt(idx);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hueDistanceDegrees(a, b) {
  const h1 = Number(a);
  const h2 = Number(b);
  if (!Number.isFinite(h1) || !Number.isFinite(h2)) return 180;
  const delta = Math.abs(h1 - h2) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function buildFallbackPreviewColor(seedText) {
  const hash = hashStringFast(seedText);
  const hue = (hash * 131 + (hash >>> 17)) % 360;
  const saturation = 72 + ((hash >>> 9) % 22);
  const lightness = 52 + ((hash >>> 21) % 12);
  const accentHue = (hue + 22 + ((hash >>> 26) % 36)) % 360;
  const accentSat = clampNumber(saturation - 10, 58, 95);
  const accentLight = clampNumber(lightness - 12, 34, 68);
  return {
    h: hue,
    s: saturation,
    l: lightness,
    ah: accentHue,
    as: accentSat,
    al: accentLight
  };
}

function buildInventoryPreviewColorProfile(mergeKey) {
  const seed = String(mergeKey || "");
  const hash = hashStringFast(seed);
  const goldenAngle = 137.50776405003785;
  let hue = ((hash % 360) + (inventoryColorCursor * goldenAngle)) % 360;
  const minGap = 32;
  const hueStep = 41 + ((hash >>> 7) % 47);

  const lookBack = Math.min(24, inventoryItems.length);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let hasConflict = false;
    for (let idx = inventoryItems.length - lookBack; idx < inventoryItems.length; idx += 1) {
      if (idx < 0) continue;
      const prevHue = Number(inventoryItems[idx]?.previewColor?.h);
      if (!Number.isFinite(prevHue)) continue;
      if (hueDistanceDegrees(hue, prevHue) < minGap) {
        hasConflict = true;
        break;
      }
    }
    if (!hasConflict) break;
    hue = (hue + hueStep) % 360;
  }

  const saturation = 74 + ((hash >>> 11) % 20);
  const lightness = 52 + ((hash >>> 19) % 12);
  const accentHue = (hue + 20 + ((hash >>> 27) % 40)) % 360;
  const accentSat = clampNumber(saturation - 8, 58, 96);
  const accentLight = clampNumber(lightness - 14, 34, 68);
  inventoryColorCursor += 1;
  return {
    h: Number(hue.toFixed(3)),
    s: saturation,
    l: lightness,
    ah: Number(accentHue.toFixed(3)),
    as: accentSat,
    al: accentLight
  };
}

function computeInventoryPreviewPalette(item) {
  const seed = String(item?.mergeKey || item?.code || item?.fileName || "");
  const profileRaw = item?.previewColor;
  const profile = (
    profileRaw &&
    Number.isFinite(profileRaw.h) &&
    Number.isFinite(profileRaw.s) &&
    Number.isFinite(profileRaw.l)
  )
    ? profileRaw
    : buildFallbackPreviewColor(seed);

  const hue = clampNumber(profile.h, 0, 359.999);
  const saturation = clampNumber(profile.s, 58, 96);
  const lightness = clampNumber(profile.l, 40, 74);
  const secondaryHue = Number.isFinite(profile.ah)
    ? clampNumber(profile.ah, 0, 359.999)
    : (hue + 24) % 360;
  const secondarySat = Number.isFinite(profile.as)
    ? clampNumber(profile.as, 52, 96)
    : clampNumber(saturation - 8, 52, 96);
  const secondaryLight = Number.isFinite(profile.al)
    ? clampNumber(profile.al, 28, 68)
    : clampNumber(lightness - 12, 28, 68);
  return {
    primary: `hsl(${hue.toFixed(2)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`,
    secondary: `hsla(${secondaryHue.toFixed(2)} ${secondarySat.toFixed(1)}% ${secondaryLight.toFixed(1)}%, 0.72)`,
    frame: `hsla(${hue.toFixed(2)} ${Math.min(94, saturation + 6).toFixed(1)}% ${Math.min(78, lightness + 8).toFixed(1)}%, 0.14)`
  };
}

function createInventoryPreviewCanvas(width = 168, height = 96) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawInventoryFallbackPreview(ctx, item, canvasWidth, canvasHeight, palette = null) {
  const colors = palette || computeInventoryPreviewPalette(item);
  const w = Math.max(1, Number(item?.width || 1));
  const h = Math.max(1, Number(item?.height || 1));
  const pad = 8;
  const availW = Math.max(1, canvasWidth - pad * 2);
  const availH = Math.max(1, canvasHeight - pad * 2);
  const scale = Math.min(availW / w, availH / h);
  const rw = Math.max(2, w * scale);
  const rh = Math.max(2, h * scale);
  const ox = (canvasWidth - rw) * 0.5;
  const oy = (canvasHeight - rh) * 0.5;

  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(ox, oy, rw, rh);
  ctx.strokeStyle = colors.secondary;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox + rw, oy + rh);
  ctx.moveTo(ox + rw, oy);
  ctx.lineTo(ox, oy + rh);
  ctx.stroke();
}

function pointToSegmentDistanceSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lenSq = (abx * abx) + (aby * aby);
  if (lenSq <= EPS) {
    const dx = px - ax;
    const dy = py - ay;
    return (dx * dx) + (dy * dy);
  }
  const t = Math.max(0, Math.min(1, ((apx * abx) + (apy * aby)) / lenSq));
  const qx = ax + (abx * t);
  const qy = ay + (aby * t);
  const dx = px - qx;
  const dy = py - qy;
  return (dx * dx) + (dy * dy);
}

function simplifyPolylineRdp(points, epsilon) {
  if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : [];
  const epsilonSq = Math.max(EPS, Number(epsilon || 0)) ** 2;
  const count = points.length;
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack = [[0, count - 1]];

  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop();
    if (endIdx - startIdx <= 1) continue;
    const a = points[startIdx];
    const b = points[endIdx];
    let bestIdx = -1;
    let bestDistSq = 0;
    for (let idx = startIdx + 1; idx < endIdx; idx += 1) {
      const p = points[idx];
      const distSq = pointToSegmentDistanceSq(p.x, p.y, a.x, a.y, b.x, b.y);
      if (distSq > bestDistSq) {
        bestDistSq = distSq;
        bestIdx = idx;
      }
    }
    if (bestIdx > startIdx && bestIdx < endIdx && bestDistSq > epsilonSq) {
      keep[bestIdx] = 1;
      stack.push([startIdx, bestIdx], [bestIdx, endIdx]);
    }
  }

  const out = [];
  for (let idx = 0; idx < count; idx += 1) {
    if (keep[idx]) out.push(points[idx]);
  }
  return out.length >= 2 ? out : points.slice(0, 2);
}

function simplifyPreviewContourPoints(pointsRaw, maxPoints = 1400) {
  const points = [];
  for (const raw of (pointsRaw || [])) {
    const x = Number(Array.isArray(raw) ? raw[0] : raw?.x);
    const y = Number(Array.isArray(raw) ? raw[1] : raw?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const prev = points[points.length - 1];
    if (prev && Math.abs(prev.x - x) <= 1e-9 && Math.abs(prev.y - y) <= 1e-9) continue;
    points.push({ x, y });
  }
  if (points.length <= 2 || points.length <= maxPoints) return points;

  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  let epsilon = Math.max(0.005, diag * 0.00014);
  let simplified = points;

  for (let iter = 0; iter < 10 && simplified.length > maxPoints; iter += 1) {
    simplified = simplifyPolylineRdp(points, epsilon);
    epsilon *= 1.7;
  }

  if (simplified.length > maxPoints) {
    const stride = Math.max(1, Math.ceil(simplified.length / maxPoints));
    const compact = [simplified[0]];
    for (let idx = stride; idx < simplified.length - 1; idx += stride) {
      compact.push(simplified[idx]);
    }
    compact.push(simplified[simplified.length - 1]);
    simplified = compact;
  }

  return simplified;
}

function drawDxfContourPreview(ctx, item, canvasWidth, canvasHeight, palette = null) {
  const colors = palette || computeInventoryPreviewPalette(item);
  const contoursRaw = Array.isArray(item?.preParsed?.contours) ? item.preParsed.contours : [];
  if (contoursRaw.length === 0) return false;

  const contours = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const contour of contoursRaw) {
    const pointsRaw = Array.isArray(contour?.points) ? contour.points : [];
    if (pointsRaw.length < 2) continue;
    const points = simplifyPreviewContourPoints(pointsRaw, 1400);
    for (const p of points) {
      const x = p.x;
      const y = p.y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (points.length >= 2) contours.push({ points, closed: !!contour?.closed });
  }

  if (contours.length === 0) return false;
  const sourceW = Math.max(EPS, maxX - minX);
  const sourceH = Math.max(EPS, maxY - minY);
  const pad = 4;
  const availW = Math.max(1, canvasWidth - pad * 2);
  const availH = Math.max(1, canvasHeight - pad * 2);
  const scale = Math.min(availW / sourceW, availH / sourceH);
  const offsetX = pad + (availW - sourceW * scale) * 0.5 - minX * scale;
  const offsetY = pad + (availH - sourceH * scale) * 0.5 + maxY * scale;

  ctx.strokeStyle = colors.primary;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const contour of contours) {
    const points = contour.points;
    if (points.length < 2) continue;
    ctx.beginPath();
    for (let idx = 0; idx < points.length; idx += 1) {
      const p = points[idx];
      const px = offsetX + p.x * scale;
      const py = offsetY - p.y * scale;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (contour.closed) ctx.closePath();
    ctx.stroke();
  }
  return true;
}

function buildInventoryPreviewDataUrl(item) {
  const canvas = createInventoryPreviewCanvas();
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return "";
  const width = canvas.width;
  const height = canvas.height;
  const palette = computeInventoryPreviewPalette(item);

  ctx.fillStyle = "#0b1525";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(15, 30, 52, 0.9)";
  ctx.fillRect(0.5, 0.5, width - 1, height - 1);
  ctx.strokeStyle = palette.frame;
  ctx.lineWidth = 0.6;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const drewDxf = String(item?.sourceType || "").toLowerCase() === PART_KIND_DXF
    ? drawDxfContourPreview(ctx, item, width, height, palette)
    : false;
  if (!drewDxf) drawInventoryFallbackPreview(ctx, item, width, height, palette);

  try {
    return canvas.toDataURL("image/webp", 0.74);
  } catch (_error) {
    return canvas.toDataURL("image/png");
  }
}

function findInventoryItemByMergeKey(mergeKey) {
  const key = String(mergeKey || "");
  if (!key) return null;
  for (const item of inventoryItems) {
    if (String(item?.mergeKey || "") === key) return item;
  }
  return null;
}

function applyInventoryPreviewToVisibleImages(mergeKey, srcUrl) {
  if (!inventoryListEl || !srcUrl) return;
  const thumbs = inventoryListEl.querySelectorAll("img.inventory-thumb");
  for (const img of thumbs) {
    if (!(img instanceof HTMLImageElement)) continue;
    if (String(img.dataset.previewKey || "") !== String(mergeKey || "")) continue;
    if (!img.src) img.src = srcUrl;
  }
}

function scheduleInventoryPreviewBuild(mergeKey) {
  const key = String(mergeKey || "");
  if (!key || inventoryPreviewPending.has(key)) return;
  inventoryPreviewPending.add(key);

  const run = () => {
    inventoryPreviewPending.delete(key);
    if (inventoryPreviewCache.has(key)) {
      applyInventoryPreviewToVisibleImages(key, inventoryPreviewCache.get(key));
      return;
    }
    const item = findInventoryItemByMergeKey(key);
    if (!item) return;
    const previewDataUrl = buildInventoryPreviewDataUrl(item);
    if (!previewDataUrl) return;
    inventoryPreviewCache.set(key, previewDataUrl);
    if (inventoryPreviewCache.size > 2600) {
      const oldestKey = inventoryPreviewCache.keys().next().value;
      if (oldestKey) inventoryPreviewCache.delete(oldestKey);
    }
    applyInventoryPreviewToVisibleImages(key, previewDataUrl);
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 900 });
  } else {
    window.setTimeout(run, 16);
  }
}

function ensureInventoryPreviewObserver() {
  if (inventoryPreviewObserver || !inventoryListEl) return;
  inventoryPreviewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target;
      if (!(target instanceof HTMLImageElement)) continue;
      const mergeKey = String(target.dataset.previewKey || "");
      if (!mergeKey) continue;
      if (inventoryPreviewCache.has(mergeKey)) {
        if (!target.src) target.src = inventoryPreviewCache.get(mergeKey);
      } else {
        scheduleInventoryPreviewBuild(mergeKey);
      }
      inventoryPreviewObserver.unobserve(target);
    }
  }, {
    root: inventoryListEl,
    rootMargin: "220px 0px"
  });
}

function observeInventoryPreviewImages() {
  if (!inventoryListEl) return;
  ensureInventoryPreviewObserver();
  const thumbs = inventoryListEl.querySelectorAll("img.inventory-thumb");
  for (const img of thumbs) {
    if (!(img instanceof HTMLImageElement)) continue;
    const mergeKey = String(img.dataset.previewKey || "");
    if (!mergeKey) continue;
    if (inventoryPreviewCache.has(mergeKey)) {
      if (!img.src) img.src = inventoryPreviewCache.get(mergeKey);
      continue;
    }
    inventoryPreviewObserver?.observe(img);
  }
}

function updateInventorySummary() {
  if (!inventorySummaryEl) return;
  const itemKinds = inventoryItems.length;
  let totalUnits = 0;
  for (const item of inventoryItems) totalUnits += Number(item.quantity || 0);
  if (itemKinds === 0 || totalUnits <= 0) {
    inventorySummaryEl.textContent = "Sem peças importadas";
    return;
  }
  inventorySummaryEl.textContent = `${itemKinds} código(s) | ${totalUnits} peça(s)`;
}

function setInventoryBusyState(isBusy) {
  inventoryBusy = !!isBusy;
  if (mountActiveSheetBtn) mountActiveSheetBtn.disabled = inventoryBusy;
  if (mountAllSheetsBtn) mountAllSheetsBtn.disabled = inventoryBusy;
}

function filteredInventoryItems() {
  const query = String(inventoryFilterQuery || "").trim().toLowerCase();
  const type = String(inventoryFilterType || "all").toLowerCase();
  return inventoryItems.filter((item) => {
    if (!item || Number(item.quantity || 0) <= 0) return false;
    if (type !== "all" && String(item.sourceType || "").toLowerCase() !== type) return false;
    if (!query) return true;
    const code = String(item.code || "").toLowerCase();
    return code.includes(query);
  });
}

function createInventoryCardElement(item) {
  const card = document.createElement("div");
  card.className = "inventory-card";
  card.dataset.itemId = String(item.id);
  card.innerHTML =
    `<div class="inventory-thumb-wrap">` +
    `<img class="inventory-thumb" data-preview-key="${item.mergeKey}" alt="Preview ${item.code}" loading="lazy" decoding="async" />` +
    `</div>` +
    `<div class="inventory-card-code">${item.code}</div>` +
    `<div class="inventory-card-meta">${formatInventorySizeLabel(item.width, item.height)}</div>` +
    `<div class="inventory-card-meta">${formatInventoryTypeLabel(item.sourceType)}</div>` +
    `<div class="inventory-qty-wrap">` +
    `<span class="inventory-qty-label">Qtd:</span>` +
    `<input class="inventory-qty-input" type="number" min="0" step="1" data-item-id="${item.id}" value="${Math.max(0, Math.round(Number(item.quantity || 0)))}" />` +
    `</div>`;
  return card;
}

function countGridTracks(template) {
  const raw = String(template || "").trim();
  if (!raw || raw === "none") return 1;
  let depth = 0;
  let count = 0;
  let token = "";
  for (let idx = 0; idx < raw.length; idx += 1) {
    const char = raw[idx];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === " " && depth === 0) {
      if (token.trim()) count += 1;
      token = "";
      continue;
    }
    token += char;
  }
  if (token.trim()) count += 1;
  return Math.max(1, count);
}

function getInventoryVirtualColumnCount() {
  if (!inventoryVirtualContentEl) return 1;
  const computed = window.getComputedStyle(inventoryVirtualContentEl);
  return countGridTracks(computed.gridTemplateColumns);
}

function ensureInventoryVirtualStructure() {
  if (!inventoryListEl) return false;
  if (!inventoryVirtualSpacerEl) {
    inventoryVirtualSpacerEl = document.createElement("div");
    inventoryVirtualSpacerEl.className = "inventory-grid-spacer";
  }
  if (!inventoryVirtualContentEl) {
    inventoryVirtualContentEl = document.createElement("div");
    inventoryVirtualContentEl.className = "inventory-grid-content";
  }
  if (
    inventoryVirtualSpacerEl.parentElement !== inventoryListEl ||
    inventoryVirtualContentEl.parentElement !== inventoryListEl
  ) {
    inventoryListEl.innerHTML = "";
    inventoryListEl.appendChild(inventoryVirtualSpacerEl);
    inventoryListEl.appendChild(inventoryVirtualContentEl);
  }
  return true;
}

function resetInventoryVirtualWindow() {
  inventoryVirtualLastStart = -1;
  inventoryVirtualLastEnd = -1;
  inventoryVirtualLastOffset = -1;
  inventoryVirtualColumns = 1;
}

function renderInventoryVirtualWindow(force = false) {
  if (!inventoryListEl) return;
  if (!ensureInventoryVirtualStructure()) return;
  if (!inventoryVirtualSpacerEl || !inventoryVirtualContentEl) return;
  const total = inventoryRenderList.length;
  if (total <= 0) {
    inventoryVirtualSpacerEl.style.height = "0px";
    inventoryVirtualContentEl.style.transform = "translateY(0px)";
    inventoryVirtualContentEl.innerHTML = "";
    resetInventoryVirtualWindow();
    return;
  }

  const columnsMeasured = getInventoryVirtualColumnCount();
  const columns = Math.max(1, columnsMeasured);
  if (columns !== inventoryVirtualColumns) {
    inventoryVirtualColumns = columns;
    force = true;
  }

  const rowStride = INVENTORY_CARD_HEIGHT + INVENTORY_CARD_GAP;
  const totalRows = Math.max(1, Math.ceil(total / columns));
  const scrollTop = Math.max(0, Number(inventoryListEl.scrollTop || 0));
  const viewportHeight = Math.max(rowStride, Number(inventoryListEl.clientHeight || rowStride));
  const startRow = Math.max(0, Math.floor(scrollTop / rowStride) - INVENTORY_VIRTUAL_OVERSCAN_ROWS);
  const endRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowStride) + INVENTORY_VIRTUAL_OVERSCAN_ROWS
  );
  const startIndex = Math.min(total, startRow * columns);
  const endIndex = Math.min(total, Math.max(startIndex, endRow * columns));
  const offsetY = startRow * rowStride;
  const spacerHeight = Math.max(0, totalRows * rowStride - INVENTORY_CARD_GAP);
  inventoryVirtualSpacerEl.style.height = `${spacerHeight}px`;

  if (
    !force &&
    startIndex === inventoryVirtualLastStart &&
    endIndex === inventoryVirtualLastEnd &&
    offsetY === inventoryVirtualLastOffset
  ) {
    return;
  }

  inventoryVirtualContentEl.style.transform = `translateY(${offsetY}px)`;
  inventoryVirtualContentEl.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (let idx = startIndex; idx < endIndex; idx += 1) {
    const item = inventoryRenderList[idx];
    if (!item) continue;
    fragment.appendChild(createInventoryCardElement(item));
  }
  inventoryVirtualContentEl.appendChild(fragment);
  inventoryVirtualLastStart = startIndex;
  inventoryVirtualLastEnd = endIndex;
  inventoryVirtualLastOffset = offsetY;
  observeInventoryPreviewImages();
}

function scheduleInventoryVirtualRender(force = false) {
  if (!inventoryListEl) return;
  if (force) {
    if (inventoryVirtualRafToken) {
      cancelAnimationFrame(inventoryVirtualRafToken);
      inventoryVirtualRafToken = 0;
    }
    renderInventoryVirtualWindow(true);
    return;
  }
  if (inventoryVirtualRafToken) return;
  inventoryVirtualRafToken = requestAnimationFrame(() => {
    inventoryVirtualRafToken = 0;
    renderInventoryVirtualWindow(false);
  });
}

function ensureInventoryVirtualResizeObserver() {
  if (!inventoryListEl) return;
  if (typeof ResizeObserver === "function") {
    if (inventoryVirtualResizeObserver) return;
    inventoryVirtualResizeObserver = new ResizeObserver(() => {
      scheduleInventoryVirtualRender(true);
    });
    inventoryVirtualResizeObserver.observe(inventoryListEl);
    return;
  }
  if (inventoryVirtualWindowResizeBound) return;
  inventoryVirtualWindowResizeBound = true;
  window.addEventListener("resize", () => {
    scheduleInventoryVirtualRender(true);
  }, { passive: true });
}

function updateInventoryListUi() {
  updateInventorySummary();
  if (!inventoryListEl) return;
  inventoryRenderList = filteredInventoryItems();
  inventoryListEl.scrollTop = 0;
  resetInventoryVirtualWindow();

  if (inventoryRenderList.length === 0) {
    inventoryListEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "inventory-empty";
    empty.textContent = "Importe DXF/STEP para criar o estoque de peças.";
    inventoryListEl.appendChild(empty);
    return;
  }

  ensureInventoryVirtualStructure();
  ensureInventoryVirtualResizeObserver();
  scheduleInventoryVirtualRender(true);
}

function removeInventoryItemById(itemId) {
  const id = Number(itemId);
  const idx = inventoryItems.findIndex((entry) => Number(entry?.id) === id);
  if (idx < 0) return false;
  const item = inventoryItems[idx];
  disposeInventoryTemplateGroup(item);
  inventoryItems.splice(idx, 1);
  if (inventoryItems.length === 0) inventoryColorCursor = 0;
  return true;
}

function disposeInventoryTemplateGroup(item) {
  if (!item?.templateGroup || !item.templateGroup.isObject3D) return;
  disposeObject3D(item.templateGroup);
  item.templateGroup = null;
}

function disposeAllInventoryTemplateGroups() {
  for (const item of inventoryItems) disposeInventoryTemplateGroup(item);
}

function applyInventoryQuantity(itemId, quantityValue) {
  const id = Number(itemId);
  const idx = inventoryItems.findIndex((entry) => Number(entry?.id) === id);
  if (idx < 0) return false;

  const parsed = Number(quantityValue);
  if (!Number.isFinite(parsed)) return false;
  const normalized = Math.max(0, Math.round(parsed));
  if (normalized <= 0) {
    const item = inventoryItems[idx];
    disposeInventoryTemplateGroup(item);
    inventoryItems.splice(idx, 1);
    if (inventoryItems.length === 0) inventoryColorCursor = 0;
    return true;
  }
  inventoryItems[idx].quantity = normalized;
  return true;
}

function upsertInventoryItem(payload) {
  const code = extractPartCodeFromName(payload?.code || payload?.fileName || "");
  if (code === "-") return false;
  const sourceType = String(payload?.sourceType || "").toLowerCase() === PART_KIND_DXF ? PART_KIND_DXF : "step";
  const key = buildInventoryMergeKey(sourceType, code);
  const existing = inventoryItems.find((entry) => entry?.mergeKey === key);
  if (existing) {
    existing.quantity = Math.max(0, Number(existing.quantity || 0)) + Math.max(0, Number(payload?.quantity || 0));
    if (!(Number(existing.width) > EPS) && Number(payload?.width) > EPS) existing.width = Number(payload.width);
    if (!(Number(existing.height) > EPS) && Number(payload?.height) > EPS) existing.height = Number(payload.height);
    if (!existing.dxfText && payload?.dxfText) existing.dxfText = payload.dxfText;
    if (!existing.stepText && payload?.stepText) existing.stepText = payload.stepText;
    if (!existing.preParsed && payload?.preParsed) existing.preParsed = payload.preParsed;
    if (!existing.fileName && payload?.fileName) existing.fileName = String(payload.fileName);
    if (!existing.meshCacheKey && payload?.meshCacheKey) existing.meshCacheKey = String(payload.meshCacheKey);
    if (!existing.stepPayload && payload?.stepPayload) existing.stepPayload = payload.stepPayload;
    if (!existing.templateSnapshot && payload?.templateSnapshot) existing.templateSnapshot = payload.templateSnapshot;
    if (!existing.templateGroup && payload?.templateGroup) existing.templateGroup = payload.templateGroup;
    if (!existing.previewColor) existing.previewColor = buildInventoryPreviewColorProfile(key);
    return true;
  }

  const previewColor = buildInventoryPreviewColorProfile(key);
  inventoryItems.push({
    id: inventoryNextId++,
    mergeKey: key,
    sourceType,
    fileName: String(payload?.fileName || code),
    code,
    width: Number(payload?.width || 0),
    height: Number(payload?.height || 0),
    quantity: Math.max(1, Math.round(Number(payload?.quantity || 1))),
    dxfText: payload?.dxfText || "",
    preParsed: payload?.preParsed || null,
    sourceThickness: Number(payload?.sourceThickness || DEFAULT_PART_THICKNESS),
    stepText: payload?.stepText || "",
    meshCacheKey: payload?.meshCacheKey ? String(payload.meshCacheKey) : "",
    stepPayload: payload?.stepPayload || null,
    templateSnapshot: payload?.templateSnapshot || null,
    templateGroup: payload?.templateGroup || null,
    previewColor
  });
  return true;
}

function getSelectedPartCode(part) {
  return extractPartCodeFromName(part?.name || "");
}

function updateSelectedPieceBadge(part) {
  if (!selectedPieceEl) return;
  const displayCode = getSelectedPartCode(part);
  selectedPieceEl.textContent = `Peca sel.: ${displayCode}`;
}

function updateSheetInfoBadge() {
  if (!sheetInfoEl) return;
  const sheetIndex = getValidSheetIndex(activeSheetIndex);
  if (sheetIndex < 0 || !sheetState[sheetIndex]) {
    sheetInfoEl.textContent = "Chapa: -";
    return;
  }
  const sheet = sheetState[sheetIndex];
  const pieces = piecesInSheet(sheetIndex);
  sheetInfoEl.textContent =
    `Chapa ${sheetIndex + 1}: ${sheet.width.toFixed(0)} x ${sheet.height.toFixed(0)} mm | ` +
    `Esp: ${sheet.spacing.toFixed(1)} | Pecas: ${pieces}`;
}

function updateSheetListUi() {
  if (!sheetListEl) return;
  sheetListEl.innerHTML = "";
  if (sheetState.length === 0) return;

  for (let idx = 0; idx < sheetState.length; idx += 1) {
    const sheet = sheetState[idx];
    if (!sheet) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `sheet-item${idx === activeSheetIndex ? " active" : ""}`;
    item.innerHTML =
      `<span class="sheet-item-title">Chapa ${idx + 1}</span>` +
      `<span class="sheet-item-meta">${sheet.width.toFixed(0)} x ${sheet.height.toFixed(0)} mm</span>` +
      `<span class="sheet-item-meta">Pecas: ${piecesInSheet(idx)} | Espacamento: ${sheet.spacing.toFixed(1)} mm</span>`;
    item.addEventListener("click", () => setActiveSheet(idx, { animate: true }));
    sheetListEl.appendChild(item);
  }
}

function fillSheetEditorForm(sheet) {
  if (!sheet) return;
  if (sheetWidthInput) sheetWidthInput.value = String(sheet.width.toFixed(2));
  if (sheetHeightInput) sheetHeightInput.value = String(sheet.height.toFixed(2));
  if (sheetThicknessInput) sheetThicknessInput.value = String(sheet.thickness.toFixed(2));
  if (sheetMarginTopInput) sheetMarginTopInput.value = String(sheet.marginTop.toFixed(2));
  if (sheetMarginBottomInput) sheetMarginBottomInput.value = String(sheet.marginBottom.toFixed(2));
  if (sheetMarginLeftInput) sheetMarginLeftInput.value = String(sheet.marginLeft.toFixed(2));
  if (sheetMarginRightInput) sheetMarginRightInput.value = String(sheet.marginRight.toFixed(2));
  if (sheetSpacingInput) sheetSpacingInput.value = String(sheet.spacing.toFixed(2));
}

function closeSheetEditorModal() {
  if (sheetEditModalEl) sheetEditModalEl.classList.add("hidden");
}

function openSheetEditorModal() {
  const sheetIndex = getValidSheetIndex(activeSheetIndex);
  if (sheetIndex < 0) return;
  fillSheetEditorForm(sheetState[sheetIndex]);
  if (sheetEditModalEl) sheetEditModalEl.classList.remove("hidden");
}
window.__openSheetEditorModal = openSheetEditorModal;

function readSheetEditorForm() {
  return normalizeSheetConfig({
    width: Number(sheetWidthInput?.value),
    height: Number(sheetHeightInput?.value),
    thickness: Number(sheetThicknessInput?.value),
    marginTop: Number(sheetMarginTopInput?.value),
    marginBottom: Number(sheetMarginBottomInput?.value),
    marginLeft: Number(sheetMarginLeftInput?.value),
    marginRight: Number(sheetMarginRightInput?.value),
    spacing: Number(sheetSpacingInput?.value)
  }, DEFAULT_SHEET_CONFIG);
}

if (newSheetBtn) {
  newSheetBtn.addEventListener("click", () => {
    sheetState.push(createSheetFrom());
    setActiveSheet(sheetState.length - 1, { animate: true });
    updateGlobalBounds();
  });
}

if (editSheetBtn) {
  editSheetBtn.addEventListener("click", () => openSheetEditorModal());
}

if (moveToSheetBtn) {
  moveToSheetBtn.addEventListener("click", () => {
    if (!selectedPart) return;
    const moved = assignPartToSheet(selectedPart, activeSheetIndex, {
      allowCreateSheet: true,
      searchAllSheets: false
    });
    if (moved) {
      updateGlobalBounds();
      updateSheetListUi();
      updateSheetInfoBadge();
    }
  });
}

if (sheetEditModalEl) {
  sheetEditModalEl.addEventListener("click", (event) => {
    if (event.target === sheetEditModalEl) closeSheetEditorModal();
  });
}

if (applySheetBtn) {
  applySheetBtn.addEventListener("click", () => {
    const sheetIndex = getValidSheetIndex(activeSheetIndex);
    if (sheetIndex < 0) return;
    const updated = readSheetEditorForm();
    sheetState[sheetIndex] = {
      ...sheetState[sheetIndex],
      ...updated
    };
    syncSheetsOrigins({ preservePartPositions: true });
    rebuildSheetsVisuals();
    relayoutSheetPieces(sheetIndex);
    closeSheetEditorModal();
    updateGlobalBounds();
    updateSheetListUi();
    updateSheetInfoBadge();
    fitToScene(1.15);
  });
}

if (applyAllSheetsBtn) {
  applyAllSheetsBtn.addEventListener("click", () => {
    if (sheetState.length === 0) return;
    const updated = readSheetEditorForm();
    setSheetCreationTemplate(updated);

    for (let idx = 0; idx < sheetState.length; idx += 1) {
      sheetState[idx] = {
        ...sheetState[idx],
        ...updated
      };
    }

    syncSheetsOrigins({ preservePartPositions: true });
    rebuildSheetsVisuals();
    for (let idx = 0; idx < sheetState.length; idx += 1) {
      relayoutSheetPieces(idx);
    }
    closeSheetEditorModal();
    updateGlobalBounds();
    updateSheetListUi();
    updateSheetInfoBadge();
    fitToScene(1.15);
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sheetEditModalEl && !sheetEditModalEl.classList.contains("hidden")) {
    closeSheetEditorModal();
  }
});

updatePieceCountBadge();
updateBatchTimeBadge(0);
updateCacheStatsBadge(null);
updateSelectedPieceBadge(null);
setInventoryBusyState(false);
updateInventoryListUi();
ensureInitialSheet();
updateSheetListUi();
updateSheetInfoBadge();
updateGlobalBounds();
fitToScene(1.18);

function decodeDxfArrayBuffer(arrayBuffer, filename = "") {
  let text = "";
  try {
    text = new TextDecoder("utf-8").decode(arrayBuffer);
  } catch (decodeUtf8Error) {
    console.warn("Falha no decode utf-8 para:", filename, decodeUtf8Error);
  }

  if (text.includes("\u0000")) {
    try {
      text = new TextDecoder("utf-16le").decode(arrayBuffer);
    } catch (decodeUtf16Error) {
      console.warn("Falha no decode utf-16le para:", filename, decodeUtf16Error);
    }
  }

  if (!/SECTION/i.test(String(text).slice(0, 1200))) {
    try {
      text = new TextDecoder("latin1").decode(arrayBuffer);
    } catch (decodeLatin1Error) {
      console.warn("Falha no decode latin1 para:", filename, decodeLatin1Error);
    }
  }

  return String(text || "").replace(/\u0000/g, "");
}

function decodeStepArrayBuffer(arrayBuffer, filename = "") {
  let text = "";
  try {
    text = new TextDecoder("utf-8").decode(arrayBuffer);
  } catch (decodeUtf8Error) {
    console.warn("Falha no decode utf-8 para STEP:", filename, decodeUtf8Error);
  }

  if (text.includes("\u0000")) {
    try {
      text = new TextDecoder("utf-16le").decode(arrayBuffer);
    } catch (decodeUtf16Error) {
      console.warn("Falha no decode utf-16le para STEP:", filename, decodeUtf16Error);
    }
  }

  if (!/ISO-10303-21/i.test(String(text).slice(0, 4000))) {
    try {
      text = new TextDecoder("latin1").decode(arrayBuffer);
    } catch (decodeLatin1Error) {
      console.warn("Falha no decode latin1 para STEP:", filename, decodeLatin1Error);
    }
  }

  return String(text || "").replace(/\u0000/g, "");
}

async function runWithConcurrency(items, limit, task) {
  const list = Array.isArray(items) ? items : Array.from(items || []);
  if (list.length === 0) return;

  const maxWorkers = Math.max(1, Math.min(Number(limit || 1), list.length));
  let nextIndex = 0;

  async function workerLoop() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= list.length) return;
      await task(list[current], current);
    }
  }

  const running = [];
  for (let i = 0; i < maxWorkers; i += 1) running.push(workerLoop());
  await Promise.all(running);
}

function base64ToArrayBuffer(base64Text) {
  const bin = atob(String(base64Text || ""));
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function importStepViaPython(stepText, filename = "arquivo.step") {
  if (typeof stepText !== "string" || !stepText.trim()) {
    return { ok: false, error: "Conteudo STEP vazio." };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId = 0;
  if (controller) {
    timeoutId = window.setTimeout(() => {
      try { controller.abort(); } catch (_error) {}
    }, STEP_PARSE_TIMEOUT_MS);
  }

  try {
    const response = await fetch("/api/parse-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: String(filename || "arquivo.step"),
        text: String(stepText || "")
      }),
      signal: controller ? controller.signal : undefined
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Endpoint STEP indisponivel (HTTP ${response.status}). Rode: py -3.9 run_server.py`
      };
    }

    const payload = await response.json().catch(() => ({}));
    if (!payload?.ok) {
      return {
        ok: false,
        error: String(payload?.error || "Falha ao processar STEP no servidor local.")
      };
    }

    return payload;
  } catch (error) {
    const isAbort = String(error?.name || "") === "AbortError";
    return {
      ok: false,
      error: isAbort
        ? "Timeout ao processar STEP no servidor local."
        : "Falha de conexao com o servidor STEP. Rode: py -3.9 run_server.py"
    };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function buildGroupFromStepPayload(payload, filename = "arquivo.step") {
  const mesh = payload?.mesh;
  if (!mesh || mesh.format !== "stl_base64" || typeof mesh.data !== "string" || !mesh.data.length) {
    return null;
  }

  const loader = new STLLoader();
  const buffer = base64ToArrayBuffer(mesh.data);
  const geometry = loader.parse(buffer);
  if (!geometry || !(geometry instanceof THREE.BufferGeometry)) return null;

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.6, 0.55),
    metalness: 0.05,
    roughness: 0.85
  });

  const meshObj = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.name = String(filename || "arquivo.step");
  group.add(meshObj);
  return group;
}

async function importSingleStepFilePythonPipeline(
  file,
  autoCenter = true,
  onIssue = null,
  onCacheEvent = null
) {
  let fileBuffer = null;
  let stepHash = "";
  let meshCacheKey = "";

  try {
    fileBuffer = await file.arrayBuffer();
  } catch (readError) {
    console.error("Falha ao ler arquivo STEP:", file?.name, readError);
    reportImportIssue(onIssue, `Falha ao ler ${file?.name || "arquivo STEP"}.`);
    return false;
  }

  try {
    stepHash = await computeArrayBufferHashHex(fileBuffer);
    meshCacheKey = buildStepMeshCacheKeyFromHash(stepHash);
  } catch (_hashError) {
    meshCacheKey = "";
  }

  if (meshCacheKey) {
    const cachedGroup = await getMeshGroupFromPersistentCache(meshCacheKey, file?.name || "");
    if (cachedGroup) {
      if (typeof onCacheEvent === "function") onCacheEvent({ type: "step-mesh-hit", fileName: file?.name || "" });
      return finalizeImportedGroup(cachedGroup, autoCenter);
    }
    if (typeof onCacheEvent === "function") onCacheEvent({ type: "step-mesh-miss", fileName: file?.name || "" });
  }

  const stepText = decodeStepArrayBuffer(fileBuffer, file?.name || "");
  const parsedPayload = await importStepViaPython(stepText, file?.name || "arquivo.step");
  if (!parsedPayload?.ok) {
    reportImportIssue(onIssue, String(parsedPayload?.error || `Falha ao importar ${file?.name || "arquivo STEP"}.`));
    return false;
  }

  const localGroup = buildGroupFromStepPayload(parsedPayload, file?.name || "arquivo.step");
  if (!localGroup) {
    reportImportIssue(onIssue, `Falha ao montar malha 3D para ${file?.name || "arquivo STEP"}.`);
    return false;
  }

  if (meshCacheKey) {
    const persistedMesh = await putMeshGroupInPersistentCache(meshCacheKey, localGroup, file, 0);
    if (typeof onCacheEvent === "function") {
      onCacheEvent({ type: persistedMesh ? "step-mesh-save" : "step-mesh-save-failed", fileName: file?.name || "" });
    }
  }

  return finalizeImportedGroup(localGroup, autoCenter);
}

function computeGroupFootprint(group) {
  if (!group) return null;
  group.updateMatrixWorld(true);
  tempBox.setFromObject(group);
  if (tempBox.isEmpty()) return null;
  return {
    width: Math.max(0, Number(tempBox.max.x) - Number(tempBox.min.x)),
    height: Math.max(0, Number(tempBox.max.y) - Number(tempBox.min.y))
  };
}

function computeStepPayloadFootprint(payload) {
  const mesh = payload?.mesh;
  if (!mesh || mesh.format !== "stl_base64" || typeof mesh.data !== "string" || !mesh.data.length) return null;
  const loader = new STLLoader();
  const geometry = loader.parse(base64ToArrayBuffer(mesh.data));
  if (!geometry || !(geometry instanceof THREE.BufferGeometry)) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const width = bounds ? Number(bounds.max.x) - Number(bounds.min.x) : 0;
  const height = bounds ? Number(bounds.max.y) - Number(bounds.min.y) : 0;
  geometry.dispose();
  return {
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

async function prepareDxfInventoryItemFromFile(file, workerPool = null, onIssue = null) {
  let fileBuffer = null;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (error) {
    reportImportIssue(onIssue, `Falha ao ler ${file?.name || "arquivo DXF"}.`);
    return false;
  }

  const dxfText = decodeDxfArrayBuffer(fileBuffer, file?.name || "");
  if (!dxfText.trim()) {
    reportImportIssue(onIssue, `Conteudo vazio em ${file?.name || "arquivo DXF"}.`);
    return false;
  }

  let parseCacheKey = "";
  try {
    parseCacheKey = await buildParsedCacheKey(fileBuffer);
  } catch (_error) {
    parseCacheKey = "";
  }

  let preParsed = null;
  if (parseCacheKey) preParsed = await getParsedFromPersistentCache(parseCacheKey);
  if (!isValidParsedPayload(preParsed)) {
    const pool = workerPool ?? getDxfWorkerPool();
    preParsed = pool ? await parseDxfWithWorkers(dxfText, file?.name || "") : null;
    if (!isValidParsedPayload(preParsed)) {
      reportImportIssue(onIssue, `Falha no parse de ${file?.name || "arquivo DXF"}.`);
      return false;
    }
    if (parseCacheKey) {
      await putParsedInPersistentCache(parseCacheKey, preParsed, file);
    }
  }

  const width = Math.max(0, Number(preParsed?.width || 0));
  const height = Math.max(0, Number(preParsed?.height || 0));
  if (width <= EPS || height <= EPS) {
    reportImportIssue(onIssue, `Nao foi possivel obter dimensoes validas para ${file?.name || "arquivo DXF"}.`);
    return false;
  }

  return upsertInventoryItem({
    sourceType: PART_KIND_DXF,
    fileName: String(file?.name || "arquivo.dxf"),
    code: String(file?.name || "arquivo.dxf"),
    width,
    height,
    quantity: 1,
    sourceThickness: DEFAULT_PART_THICKNESS,
    dxfText,
    preParsed
  });
}

async function prepareStepInventoryItemFromFile(file, onIssue = null) {
  let fileBuffer = null;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (error) {
    reportImportIssue(onIssue, `Falha ao ler ${file?.name || "arquivo STEP"}.`);
    return false;
  }

  const stepText = decodeStepArrayBuffer(fileBuffer, file?.name || "");
  if (!stepText.trim()) {
    reportImportIssue(onIssue, `Conteudo vazio em ${file?.name || "arquivo STEP"}.`);
    return false;
  }

  let meshCacheKey = "";
  try {
    const stepHash = await computeArrayBufferHashHex(fileBuffer);
    meshCacheKey = buildStepMeshCacheKeyFromHash(stepHash);
  } catch (_error) {
    meshCacheKey = "";
  }

  let width = 0;
  let height = 0;
  let stepPayload = null;
  let templateSnapshot = null;

  if (meshCacheKey) {
    const cachedGroup = await getMeshGroupFromPersistentCache(meshCacheKey, file?.name || "");
    if (cachedGroup) {
      const cachedFootprint = computeGroupFootprint(cachedGroup);
      if (cachedFootprint) {
        width = cachedFootprint.width;
        height = cachedFootprint.height;
      }
      templateSnapshot = serializeMeshGroupSnapshot(cachedGroup, 0);
      disposeObject3D(cachedGroup);
    }
  }

  if (width <= EPS || height <= EPS) {
    stepPayload = await importStepViaPython(stepText, file?.name || "arquivo.step");
    if (!stepPayload?.ok) {
      reportImportIssue(onIssue, String(stepPayload?.error || `Falha ao importar ${file?.name || "arquivo STEP"}.`));
      return false;
    }
    const footprint = computeStepPayloadFootprint(stepPayload);
    if (!footprint || footprint.width <= EPS || footprint.height <= EPS) {
      reportImportIssue(onIssue, `Nao foi possivel obter dimensoes validas para ${file?.name || "arquivo STEP"}.`);
      return false;
    }
    width = footprint.width;
    height = footprint.height;
  }

  return upsertInventoryItem({
    sourceType: "step",
    fileName: String(file?.name || "arquivo.step"),
    code: String(file?.name || "arquivo.step"),
    width,
    height,
    quantity: 1,
    stepText,
    meshCacheKey,
    stepPayload,
    templateSnapshot
  });
}

async function ensureInventoryTemplateSnapshot(item, onIssue = null) {
  if (!item || Number(item.quantity || 0) <= 0) return false;
  if (item.templateGroup && item.templateGroup.isObject3D) {
    if (!item.templateSnapshot) {
      const snapshotThickness = String(item.sourceType || "").toLowerCase() === PART_KIND_DXF
        ? Number(item.sourceThickness || DEFAULT_PART_THICKNESS)
        : 0;
      item.templateSnapshot = serializeMeshGroupSnapshot(item.templateGroup, snapshotThickness);
    }
    return !!item.templateSnapshot;
  }

  if (item.templateSnapshot) {
    const fromSnapshot = buildGroupFromMeshSnapshot(item.templateSnapshot, item.fileName || "");
    if (fromSnapshot) {
      item.templateGroup = fromSnapshot;
      return true;
    }
    item.templateSnapshot = null;
  }

  let templateGroup = null;
  if (String(item.sourceType || "").toLowerCase() === PART_KIND_DXF) {
    const built = addDxfToScene(
      String(item.dxfText || ""),
      String(item.fileName || `${item.code}.dxf`),
      Number(item.sourceThickness || DEFAULT_PART_THICKNESS),
      true,
      onIssue,
      item.preParsed || null,
      null,
      { finalizeInScene: false }
    );
    templateGroup = built && built.isObject3D ? built : null;
  } else {
    if (item.meshCacheKey) {
      templateGroup = await getMeshGroupFromPersistentCache(item.meshCacheKey, item.fileName || "");
    }
    if (!templateGroup) {
      let payload = item.stepPayload;
      if (!payload?.ok) payload = await importStepViaPython(String(item.stepText || ""), item.fileName || "arquivo.step");
      if (!payload?.ok) {
        reportImportIssue(onIssue, String(payload?.error || `Falha ao montar ${item.fileName || "arquivo STEP"}.`));
        return false;
      }
      item.stepPayload = payload;
      templateGroup = buildGroupFromStepPayload(payload, item.fileName || "arquivo.step");
      if (!templateGroup) {
        reportImportIssue(onIssue, `Falha ao construir malha para ${item.fileName || "arquivo STEP"}.`);
        return false;
      }
      if (item.meshCacheKey) {
        await putMeshGroupInPersistentCache(item.meshCacheKey, templateGroup, { name: item.fileName || "" }, 0);
      }
    }
  }

  if (!templateGroup) return false;
  const snapshotThickness = String(item.sourceType || "").toLowerCase() === PART_KIND_DXF
    ? Number(item.sourceThickness || DEFAULT_PART_THICKNESS)
    : 0;
  const snapshot = serializeMeshGroupSnapshot(templateGroup, snapshotThickness);
  if (!snapshot) return false;
  item.templateSnapshot = snapshot;
  item.templateGroup = templateGroup;
  return true;
}

async function createSceneGroupFromInventoryItem(item, onIssue = null) {
  const okTemplate = await ensureInventoryTemplateSnapshot(item, onIssue);
  if (!okTemplate) return null;
  const group = item.templateGroup?.clone(true) || null;
  if (!group) return null;
  group.name = String(item.fileName || `${item.code || "peca"}.dxf`);
  if (String(item.sourceType || "").toLowerCase() === PART_KIND_DXF) {
    markPartAsDxf(group, Number(item.sourceThickness || DEFAULT_PART_THICKNESS));
  }
  return group;
}

function pruneEmptyInventoryItems() {
  for (let idx = inventoryItems.length - 1; idx >= 0; idx -= 1) {
    if (Number(inventoryItems[idx]?.quantity || 0) <= 0) {
      const item = inventoryItems[idx];
      disposeInventoryTemplateGroup(item);
      inventoryItems.splice(idx, 1);
    }
  }
}

async function mountInventoryToSheets({ acrossAllSheets = false } = {}) {
  if (inventoryBusy) return;
  if (inventoryItems.length === 0) return;
  ensureInitialSheet();

  setInventoryBusyState(true);
  const mountStart = performance.now();
  const issues = [];
  let placedCount = 0;

  try {
    const preferredSheet = getValidSheetIndex(activeSheetIndex) >= 0 ? getValidSheetIndex(activeSheetIndex) : 0;
    for (const item of inventoryItems) {
      if (!item || Number(item.quantity || 0) <= 0) continue;

      while (Number(item.quantity || 0) > 0) {
        const group = await createSceneGroupFromInventoryItem(item, (msg) => issues.push(msg));
        if (!group) {
          issues.push(`Falha ao montar template para ${item.code || item.fileName || "peça"}.`);
          break;
        }

        const placed = finalizeImportedGroup(group, DEFAULT_AUTO_CENTER, {
          preferredSheetIndex: preferredSheet,
          allowCreateSheet: !!acrossAllSheets,
          searchAllSheets: !!acrossAllSheets,
          strictPlacement: true
        });

        if (!placed) break;
        item.quantity = Math.max(0, Number(item.quantity || 0) - 1);
        placedCount += 1;
      }
    }
  } finally {
    pruneEmptyInventoryItems();
    updateInventoryListUi();
    updateBatchTimeBadge(performance.now() - mountStart);
    setInventoryBusyState(false);
  }

  if (issues.length > 0) {
    const uniqueIssues = [...new Set(issues)];
    for (const msg of uniqueIssues) console.warn("[Montagem estoque]", msg);
  }

  if (placedCount === 0 && inventoryItems.length > 0 && !acrossAllSheets) {
    console.info("Nenhuma peça adicional coube na chapa ativa.");
  }
}

if (inventorySearchInput) {
  inventorySearchInput.addEventListener("input", () => {
    inventoryFilterQuery = String(inventorySearchInput.value || "");
    updateInventoryListUi();
  });
}

if (inventoryTypeFilterEl) {
  inventoryTypeFilterEl.addEventListener("change", () => {
    inventoryFilterType = String(inventoryTypeFilterEl.value || "all").toLowerCase();
    updateInventoryListUi();
  });
}

if (inventoryListEl) {
  inventoryListEl.addEventListener("scroll", () => {
    scheduleInventoryVirtualRender();
  });

  inventoryListEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains("inventory-qty-input")) return;
    event.preventDefault();
    const itemId = Number(target.dataset.itemId);
    const applied = applyInventoryQuantity(itemId, Number(target.value));
    if (applied) updateInventoryListUi();
  });
}

if (mountActiveSheetBtn) {
  mountActiveSheetBtn.addEventListener("click", async () => {
    await mountInventoryToSheets({ acrossAllSheets: false });
  });
}

if (mountAllSheetsBtn) {
  mountAllSheetsBtn.addEventListener("click", async () => {
    await mountInventoryToSheets({ acrossAllSheets: true });
  });
}

if (fileInput) {
  fileInput.addEventListener("change", async (ev) => {
    const files = [...(ev.target.files || [])].filter((f) => /\.dxf$/i.test(String(f?.name || "")));
    if (files.length === 0) return;

    const importStart = performance.now();
    const importIssues = [];
    let importedCount = 0;
    const workerPool = getDxfWorkerPool();

    await runWithConcurrency(files, DXF_PARSE_WORKERS, async (f) => {
      try {
        const ok = await prepareDxfInventoryItemFromFile(f, workerPool, (msg) => importIssues.push(msg));
        if (ok) importedCount += 1;
      } catch (error) {
        console.error("Falha inesperada no import de estoque DXF:", f?.name, error);
        importIssues.push(`Falha inesperada ao importar ${f?.name || "arquivo DXF"}.`);
      } finally {
        updateBatchTimeBadge(performance.now() - importStart);
      }
    });

    updateBatchTimeBadge(performance.now() - importStart);
    updateInventoryListUi();

    if (importIssues.length > 0) {
      const uniqueIssues = [...new Set(importIssues)];
      for (const msg of uniqueIssues) console.warn("[Import warning]", msg);
      if (importedCount === 0) {
        const shownIssues = uniqueIssues.slice(0, 8);
        const moreCount = uniqueIssues.length - shownIssues.length;
        const body = shownIssues.map((msg, idx) => `${idx + 1}. ${msg}`).join("\n");
        const suffix = moreCount > 0 ? `\n... e mais ${moreCount} aviso(s).` : "";
        alert(`Nenhuma peça DXF válida foi importada.\n\n${body}${suffix}`);
      }
    }

    fileInput.value = "";
  });
}

if (stepInput) {
  stepInput.addEventListener("change", async (ev) => {
    const files = [...(ev.target.files || [])].filter((f) => /\.(step|stp)$/i.test(String(f?.name || "")));
    if (files.length === 0) return;

    const importStart = performance.now();
    const importIssues = [];
    let importedCount = 0;

    await runWithConcurrency(files, STEP_IMPORT_WORKERS, async (f) => {
      try {
        const ok = await prepareStepInventoryItemFromFile(f, (msg) => importIssues.push(msg));
        if (ok) importedCount += 1;
      } catch (error) {
        console.error("Falha inesperada no import de estoque STEP:", f?.name, error);
        importIssues.push(`Falha inesperada ao importar ${f?.name || "arquivo STEP"}.`);
      } finally {
        updateBatchTimeBadge(performance.now() - importStart);
      }
    });

    updateBatchTimeBadge(performance.now() - importStart);
    updateInventoryListUi();

    if (importIssues.length > 0) {
      const uniqueIssues = [...new Set(importIssues)];
      for (const msg of uniqueIssues) console.warn("[Import warning]", msg);
      if (importedCount === 0) {
        const shownIssues = uniqueIssues.slice(0, 8);
        const moreCount = uniqueIssues.length - shownIssues.length;
        const body = shownIssues.map((msg, idx) => `${idx + 1}. ${msg}`).join("\n");
        const suffix = moreCount > 0 ? `\n... e mais ${moreCount} aviso(s).` : "";
        alert(`Nenhuma peça STEP válida foi importada.\n\n${body}${suffix}`);
      }
    }

    stepInput.value = "";
  });
}

fitBtn.addEventListener("click", () => {
  updateGlobalBounds();
  fitToScene();
});

clearBtn.addEventListener("click", () => {
  clearSelection();
  while (partsGroup.children.length) {
    const child = partsGroup.children[0];
    partsGroup.remove(child);
    disposeObject3D(child);
  }
  disposeAllInventoryTemplateGroups();
  inventoryItems.length = 0;
  inventoryColorCursor = 0;
  inventoryPreviewCache.clear();
  inventoryPreviewPending.clear();
  disposeInactiveProxyInstancedMesh();
  inactiveProxyDirty = false;
  updateGlobalBounds();
  updatePieceCountBadge();
  updateSheetListUi();
  updateSheetInfoBadge();
  updateInventoryListUi();
});

window.addEventListener("beforeunload", () => {
  disposeAllInventoryTemplateGroups();
  disposeInactiveProxyInstancedMesh();
  if (dxfWorkerPool && typeof dxfWorkerPool.terminate === "function") {
    dxfWorkerPool.terminate();
  }
});

// ---------------------------
// Render loop
// ---------------------------
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  if (fpsLastFrameTs > 0) {
    fpsAccumMs += Math.max(0, now - fpsLastFrameTs);
    fpsFrameCounter += 1;
  }
  fpsLastFrameTs = now;
  if (fpsAccumMs >= 500) {
    fpsDisplayValue = fpsFrameCounter > 0 ? (fpsFrameCounter * 1000) / fpsAccumMs : 0;
    updateFpsBadgeText(fpsDisplayValue);
    fpsAccumMs = 0;
    fpsFrameCounter = 0;
  }

  if (!bboxAll.isEmpty()) {
    bboxAll.getSize(cameraDepthSizeVec);
    const maxDim = Math.max(cameraDepthSizeVec.x, cameraDepthSizeVec.y, cameraDepthSizeVec.z);
    updateCameraDepthRange({
      maxDimension: maxDim,
      cameraDistance: camera.position.distanceTo(controls.target)
    });
  }
  const transitionActive = updateSheetRingTransition(now);
  syncInactiveProxyInstancing({ transitionActive });
  controls.update();
  renderer.render(scene, camera);
}
updateFpsBadgeText(0);
animate();
