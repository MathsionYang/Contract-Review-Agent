const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
    const nextState = cloneState({ ...DEFAULT_STATE, ...state });
    nextState.projects = Array.isArray(nextState.projects) ? nextState.projects : [];
    nextState.reviews = nextState.reviews && typeof nextState.reviews === "object" ? nextState.reviews : {};
    nextState.auditRecords = Array.isArray(nextState.auditRecords) ? nextState.auditRecords : [];
    writeJsonAtomically(statePath, nextState);
    return nextState;
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

  return { loadState, saveState, saveProjectFile, saveKnowledgeFile, statePath, rootDir: root };
}

module.exports = { createStorage };
