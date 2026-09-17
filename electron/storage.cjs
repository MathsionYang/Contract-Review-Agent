const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { deleteReviewTask, reconcileDeletedTasks } = require("../src/services/reviewTasks.mjs");
const { reconcileDeletedKnowledge } = require("../src/services/knowledgeManagement.mjs");

const DEFAULT_STATE = {
  activeProjectId: null,
  projects: [],
  reviews: {},
  auditRecords: []
};

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function safeSegment(value, fallback) {
  const segment = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim();
  return segment || fallback;
}

function cloneState(state) {
  if (!state || typeof state !== "object") return { ...DEFAULT_STATE };
  return JSON.parse(JSON.stringify(state));
}

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function createStorage(rootDir) {
  const root = path.resolve(rootDir);
  const stateDirectory = ensureDirectory(path.join(root, "state"));
  const statePath = path.join(stateDirectory, "state.json");
  const projectDirectory = ensureDirectory(path.join(root, "projects"));
  const knowledgeDirectory = ensureDirectory(path.join(root, "knowledge"));
  const extractionCacheDirectory = ensureDirectory(path.join(root, "cache", "extractions"));

  // 抽取缓存是纯性能副本：按合同内容哈希存放，键不匹配即视为未命中，损坏文件直接删除重算。
  function extractionCachePath(documentHash) {
    return path.join(extractionCacheDirectory, `${String(documentHash || "").replace(/[^a-f0-9]/gi, "").slice(0, 64) || "unknown"}.json`);
  }

  function loadExtractionCache(documentHash) {
    const filePath = extractionCachePath(documentHash);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      try { fs.unlinkSync(filePath); } catch (_ignored) { /* 丢弃损坏缓存即可 */ }
      return null;
    }
  }

  function saveExtractionCache(documentHash, entry) {
    if (!String(documentHash || "").trim()) return null;
    writeJsonAtomically(extractionCachePath(documentHash), entry);
    return entry;
  }

  function deleteExtractionCache(documentHash) {
    const filePath = extractionCachePath(documentHash);
    if (!fs.existsSync(filePath)) return false;
    try { fs.unlinkSync(filePath); return true; } catch (_error) { return false; }
  }

  function clearExtractionCache() {
    let removed = 0;
    let bytes = 0;
    let files = [];
    try { files = fs.readdirSync(extractionCacheDirectory); } catch (_error) { files = []; }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(extractionCacheDirectory, name);
      try { bytes += fs.statSync(filePath).size; fs.unlinkSync(filePath); removed += 1; } catch (_error) { /* 单个失败不影响其余 */ }
    }
    return { removed, bytes };
  }

  // 列出当前缓存里的合同哈希，供删除任务时判断哪些已无人引用。
  function listExtractionCacheHashes() {
    try { return fs.readdirSync(extractionCacheDirectory).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")); }
    catch (_error) { return []; }
  }

  // 删除任务时调用：只清理传入的哈希，绝不动其它任务仍在引用的缓存。
  function pruneExtractionCache(hashes = []) {
    let removed = 0;
    for (const hash of Array.isArray(hashes) ? hashes : []) {
      if (!String(hash || "").trim()) continue;
      try { if (fs.existsSync(extractionCachePath(hash))) { fs.unlinkSync(extractionCachePath(hash)); removed += 1; } } catch (_error) { /* 忽略单个失败 */ }
    }
    return removed;
  }

  function loadState() {
    if (!fs.existsSync(statePath)) return cloneState(DEFAULT_STATE);
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return {
        ...cloneState(DEFAULT_STATE),
        ...parsed,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        reviews: parsed.reviews && typeof parsed.reviews === "object" ? parsed.reviews : {},
        auditRecords: Array.isArray(parsed.auditRecords) ? parsed.auditRecords : []
      };
    } catch (error) {
      const wrapped = new Error("本地状态文件损坏，无法读取");
      wrapped.code = "STATE_CORRUPTED";
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function saveState(state) {
    let nextState = cloneState({ ...DEFAULT_STATE, ...state });
    nextState.projects = Array.isArray(nextState.projects) ? nextState.projects : [];
    nextState.reviews = nextState.reviews && typeof nextState.reviews === "object" ? nextState.reviews : {};
    nextState.auditRecords = Array.isArray(nextState.auditRecords) ? nextState.auditRecords : [];
    const saved = loadState();
    nextState = reconcileDeletedKnowledge(reconcileDeletedTasks(nextState, saved), saved);
    writeJsonAtomically(statePath, nextState);
    return nextState;
  }

  function deleteTask(projectId) {
    return saveState(deleteReviewTask(loadState(), projectId));
  }

  function saveProjectFile({ projectId, versionId, sourcePath, fileName }) {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      const error = new Error("合同原始文件不存在");
      error.code = "FILE_NOT_FOUND";
      throw error;
    }

    const projectPath = ensureDirectory(path.join(
      projectDirectory,
      safeSegment(projectId, "project")
    ));
    const versionPath = ensureDirectory(path.join(
      projectPath,
      "file-versions",
      safeSegment(versionId, "version")
    ));
    const originalName = safeSegment(path.basename(fileName || sourcePath), "contract");
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${originalName}`;
    const storedPath = path.join(versionPath, uniqueName);

    // 使用独立文件名保存每一次导入，避免新版本覆盖原始文件。
    fs.copyFileSync(sourcePath, storedPath, fs.constants.COPYFILE_EXCL);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(storedPath)).digest("hex");
    const stats = fs.statSync(storedPath);
    return {
      storedPath,
      fileName: originalName,
      sha256: hash,
      sizeBytes: stats.size,
      projectId,
      versionId,
      createdAt: new Date().toISOString()
    };
  }

  function saveKnowledgeFile({ kind, versionId, sourcePath, fileName }) {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      const error = new Error("知识文件不存在");
      error.code = "KNOWLEDGE_FILE_NOT_FOUND";
      throw error;
    }
    const safeKind = safeSegment(kind, "knowledge");
    const safeVersion = safeSegment(versionId, "version");
    const versionPath = ensureDirectory(path.join(knowledgeDirectory, safeKind, safeVersion));
    const originalName = safeSegment(path.basename(fileName || sourcePath), "knowledge-file");
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${originalName}`;
    const storedPath = path.join(versionPath, uniqueName);
    fs.copyFileSync(sourcePath, storedPath, fs.constants.COPYFILE_EXCL);
    const buffer = fs.readFileSync(storedPath);
    const stats = fs.statSync(storedPath);
    return {
      storedPath,
      fileName: originalName,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: stats.size,
      kind: safeKind,
      versionId: safeVersion,
      createdAt: new Date().toISOString()
    };
  }

  return { loadState, saveState, deleteTask, saveProjectFile, saveKnowledgeFile, statePath, rootDir: root,
    loadExtractionCache, saveExtractionCache, deleteExtractionCache, clearExtractionCache, pruneExtractionCache,
    listExtractionCacheHashes, extractionCacheDirectory };
}

module.exports = { createStorage };
