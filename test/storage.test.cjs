const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStorage } = require("../electron/storage.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-storage-"));
}

test("本地状态可以被新的存储实例重新读取", () => {
  const rootDir = tempDir();
  const first = createStorage(rootDir);
  first.saveState({ projects: [{ project_id: "project-1" }], auditRecords: [] });

  const second = createStorage(rootDir);
  assert.equal(second.loadState().projects[0].project_id, "project-1");
});

test("原始文件按项目版本复制且不会覆盖已有版本", () => {
  const rootDir = tempDir();
  const sourcePath = path.join(rootDir, "合同原件.txt");
  fs.writeFileSync(sourcePath, "合同正文");

  const storage = createStorage(rootDir);
  const first = storage.saveProjectFile({
    projectId: "project-1",
    versionId: "contract_v1",
    sourcePath,
    fileName: "合同原件.txt"
  });
  const second = storage.saveProjectFile({
    projectId: "project-1",
    versionId: "contract_v1",
    sourcePath,
    fileName: "合同原件.txt"
  });

  assert.notEqual(first.storedPath, second.storedPath);
  assert.equal(fs.readFileSync(first.storedPath, "utf8"), "合同正文");
  assert.equal(fs.readFileSync(second.storedPath, "utf8"), "合同正文");
});
