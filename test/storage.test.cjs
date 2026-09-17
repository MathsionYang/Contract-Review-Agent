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

test("删除任务只清理指定项目和审查记录，保留文件、其他项目及配置", () => {
  const rootDir = tempDir();
  const storage = createStorage(rootDir);
  const sourcePath = path.join(rootDir, "source.txt");
  const exportedPath = path.join(rootDir, "report.json");
  fs.writeFileSync(sourcePath, "contract");
  fs.writeFileSync(exportedPath, "report");
  const file = storage.saveProjectFile({ projectId: "one", versionId: "v1", sourcePath });
  const initial = storage.saveState({
    activeProjectId: "one",
    projects: [{ project_id: "one", stored_path: file.storedPath }, { project_id: "two" }],
    reviews: { one: { risks: [{}], chat_sessions: [{}], humanRevisions: [{}], exportRecords: [{ path: exportedPath }] }, two: { risks: [] } },
    capabilities: { models: [{ id: "model-1" }, { id: "model-2" }] },
    knowledge: { memory: [{ id: "confirmed-memory" }] },
    settings: { setting: true },
    auditRecords: [{ audit_id: "existing" }]
  });
  const result = storage.deleteTask("one");
  assert.deepEqual(result.projects, [{ project_id: "two" }]);
  assert.deepEqual(result.reviews, { two: { risks: [] } });
  assert.equal(result.activeProjectId, "two");
  for (const key of ["capabilities", "knowledge", "settings"]) assert.deepEqual(result[key], initial[key]);
  assert.equal(result.auditRecords[0].event_type, "review_task_deleted");
  assert.equal(result.auditRecords[1].audit_id, "existing");
  for (const filePath of [sourcePath, file.storedPath, exportedPath]) assert.equal(fs.existsSync(filePath), true);
  assert.deepEqual(createStorage(rootDir).loadState(), result);
});

test("删掉最后一个任务后，旧快照不能恢复项目、审查记录或抹掉删除审计", () => {
  const storage = createStorage(tempDir());
  const stale = storage.saveState({ activeProjectId: "one", projects: [{ project_id: "one" }], reviews: { one: { risks: [] } } });
  storage.deleteTask("one");
  const result = storage.saveState(stale);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.reviews, {});
  assert.equal(result.activeProjectId, null);
  assert.deepEqual(result.deletedProjectIds, ["one"]);
  assert.equal(result.auditRecords.length, 1);
  assert.deepEqual(storage.saveState(stale), result);
  assert.deepEqual(storage.loadState(), result);
});

test("删除非当前任务不切换当前项目，不存在的任务不会写入状态", () => {
  const storage = createStorage(tempDir());
  storage.saveState({ activeProjectId: "one", projects: [{ project_id: "one" }, { project_id: "two" }], reviews: { one: {}, two: {} } });
  const result = storage.deleteTask("two");
  assert.equal(result.activeProjectId, "one");
  for (const id of ["two", "missing", "", null, { project_id: "one" }]) assert.throws(() => storage.deleteTask(id));
  assert.deepEqual(storage.loadState(), result);
});

test("删除写入失败时原任务仍可重新读取", (t) => {
  const storage = createStorage(tempDir());
  const initial = storage.saveState({ projects: [{ project_id: "one" }], reviews: { one: {} } });
  t.mock.method(fs, "renameSync", () => { throw new Error("test write failure"); });
  assert.throws(() => storage.deleteTask("one"), /test write failure/);
  assert.deepEqual(storage.loadState(), initial);
});
