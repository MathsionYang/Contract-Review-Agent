const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCredentialStore } = require("../electron/credential-store.cjs");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(`encrypted:${value}`, "utf8");
    },
    decryptString(value) {
      return value.toString("utf8").replace(/^encrypted:/, "");
    }
  };
}

test("本机凭据存储支持多引用、覆盖和存在性查询，文件不写入明文 Key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-credentials-"));
  try {
    const store = createCredentialStore(root, fakeSafeStorage());
    store.save("cred://deepseek/analysis", "sk-analysis-secret");
    store.save("cred://aliyun/embedding", "sk-embedding-secret");

    assert.equal(store.has("cred://deepseek/analysis"), true);
    assert.equal(store.get("cred://deepseek/analysis"), "sk-analysis-secret");
    assert.equal(store.get("cred://aliyun/embedding"), "sk-embedding-secret");
    assert.equal(store.has("cred://missing"), false);
    assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /sk-analysis-secret|sk-embedding-secret/);

    store.save("cred://deepseek/analysis", "sk-analysis-replaced");
    assert.equal(store.get("cred://deepseek/analysis"), "sk-analysis-replaced");
    assert.throws(() => store.save("none", "secret"), /凭据引用不能为空/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
