const fs = require("node:fs");
const path = require("node:path");

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function cloneEntries(entries) {
  return entries && typeof entries === "object" && !Array.isArray(entries) ? { ...entries } : {};
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function createCredentialStore(rootDir, safeStorage) {
  if (!safeStorage || typeof safeStorage.encryptString !== "function" || typeof safeStorage.decryptString !== "function") {
    throw new Error("当前 Electron 不支持本机安全凭据存储");
  }

  const stateDirectory = ensureDirectory(path.join(path.resolve(rootDir), "state"));
  const filePath = path.join(stateDirectory, "credentials.json");

  function readEntries() {
    if (!fs.existsSync(filePath)) return {};
    try {
      return cloneEntries(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error) {
      const wrapped = new Error("本地凭据文件损坏，无法读取");
      wrapped.code = "CREDENTIAL_STORE_CORRUPTED";
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function writeEntries(entries) {
    writeJsonAtomically(filePath, cloneEntries(entries));
  }

  function validateReference(reference) {
    const value = String(reference || "").trim();
    if (!value || value === "none") throw new Error("凭据引用不能为空");
    return value;
  }

  function save(reference, secret) {
    const key = validateReference(reference);
    const value = String(secret || "").trim();
    if (!value) throw new Error("API Key 不能为空");
    if (typeof safeStorage.isEncryptionAvailable === "function" && !safeStorage.isEncryptionAvailable()) {
      const error = new Error("本机安全存储暂不可用，无法保存 API Key");
      error.code = "CREDENTIAL_ENCRYPTION_UNAVAILABLE";
      throw error;
    }
    const entries = readEntries();
    entries[key] = safeStorage.encryptString(value).toString("base64");
    writeEntries(entries);
    return { configured: true };
  }

  function get(reference) {
    const key = String(reference || "").trim();
    if (!key || key === "none") return "";
    const encoded = readEntries()[key];
    if (!encoded) return "";
    try {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch (_error) {
      return "";
    }
  }

  function has(reference) {
    const key = String(reference || "").trim();
    return Boolean(key && key !== "none" && readEntries()[key]);
  }

  return { save, get, has, filePath };
}

module.exports = { createCredentialStore };
