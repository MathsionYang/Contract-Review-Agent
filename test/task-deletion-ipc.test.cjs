const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createStorage } = require("../electron/storage.cjs");

function createHarness(runReview = async ({ review }) => ({ review }), chooseDirectory = async () => ({ canceled: true })) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-delete-ipc-"));
  const storage = createStorage(rootDir);
  const handlers = new Map();
  let chats = 0;
  const mainPath = path.resolve(__dirname, "../electron/main.cjs");
  const realRequire = createRequire(mainPath);
  class Window {
    loadFile() {}
    loadURL() {}
    isDestroyed() { return false; }
    webContents = { send() {} };
  }
  vm.runInNewContext(fs.readFileSync(mainPath, "utf8"), {
    require(name) {
      if (name === "electron") return {
        app: { disableHardwareAcceleration() {}, getPath: () => rootDir, whenReady: () => ({ then: (ready) => ready() }), on() {} },
        BrowserWindow: Window,
        dialog: { showOpenDialog: chooseDirectory },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
      };
      if (name === "./review-runner.cjs") return { runReview };
      if (name === "./credential-store.cjs") return { createCredentialStore: () => ({}) };
      if (name === "./review-chat.cjs") return { createReviewChatService: () => ({ activeRequestCount: () => chats }) };
      return realRequire(name);
    },
    module: { exports: {} },
    __dirname: path.dirname(mainPath),
    process: { env: {}, platform: "win32" }
  }, { filename: mainPath });
  const projects = [{ project_id: "one" }, { project_id: "two" }];
  const initial = storage.saveState({
    activeProjectId: "one", projects,
    reviews: Object.fromEntries(projects.map((project) => [project.project_id, { project, risks: [], task: { status: "completed" } }]))
  });
  return { storage, initial, call: (channel, options) => handlers.get(channel)(null, options), setChats: (count) => { chats = count; } };
}

test("主进程拒绝运行期间删除，执行结束后允许删除且旧 IPC 快照不可恢复任务", async () => {
  let finish;
  const harness = createHarness(({ review }) => new Promise((resolve) => { finish = () => resolve({ review }); }));
  const running = harness.call("review:run", { projectId: "one" });
  assert.throws(() => harness.call("review:delete-task", { projectId: "two" }), /正在运行/);
  finish();
  await running;
  harness.setChats(1);
  assert.throws(() => harness.call("review:delete-task", { projectId: "two" }), /正在运行/);
  harness.setChats(0);
  const result = harness.call("review:delete-task", { projectId: "one" });
  assert.equal(result.activeProjectId, "two");
  const saved = harness.call("state:save", harness.initial);
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.reviews.one, undefined);
  await assert.rejects(harness.call("review:run", { projectId: "one", review: harness.initial.reviews.one }), /已被删除/);
  assert.throws(() => harness.call("review:delete-task", { projectId: "missing" }), /不存在/);
});

test("审查执行异常后释放删除保护，历史 running 状态不会永久阻止清理", async () => {
  const harness = createHarness(async () => { throw new Error("test runner failed"); });
  await assert.rejects(harness.call("review:run", { projectId: "one" }), /test runner failed/);
  const state = harness.storage.loadState();
  state.reviews.one.task.status = "running";
  harness.storage.saveState(state);
  assert.equal(harness.call("review:delete-task", { projectId: "one" }).reviews.one, undefined);
});

test("导出 IPC 传递模式、保留待核验状态、记录草稿审计，正式与安全阻断不可绕过", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-policy-ipc-"));
  let dialogs = 0;
  const harness = createHarness(undefined, async () => { dialogs += 1; return { canceled: false, filePaths: [outputDir] }; });
  const review = {
    project: { project_id: "one", project_name: "export test", file_version_id: "v1", contract_type: "procurement" },
    document: { text: "contract text", sha256: "a".repeat(64) },
    task: { status: "partial" },
    config: { snapshot: { status: "draft" } },
    risks: [{ risk_id: "risk-1", risk_level: "high", title: "test risk", conclusion_status: "candidate", evidence_status: "unverified", human_status: "pending_review" }]
  };
  const state = harness.storage.loadState();
  state.reviews.one = review;
  harness.storage.saveState(state);
  assert.equal(harness.call("review:validate-export", { review, formats: ["JSON"], mode: "draft" }).canExport, true);
  const blocked = await harness.call("review:export", { review, formats: ["JSON"], mode: "formal" });
  assert.equal(blocked.validation.canExport, false);
  assert.equal(dialogs, 0);
  const draft = await harness.call("review:export", { review, formats: ["JSON"], mode: "draft" });
  assert.equal(dialogs, 1);
  assert.equal(draft.records[0].export_mode, "draft");
  assert.equal(draft.state.reviews.one.risks[0].human_status, "pending_review");
  assert.equal(draft.state.reviews.one.task.status, "partial");
  assert.equal(draft.state.reviews.one.exportRecords[0].report_status, "draft");
  assert.equal(draft.state.auditRecords[0].result, "草稿已生成");
  assert.ok(draft.state.auditRecords[0].detail.includes("PENDING_HUMAN_REVIEW"));
  harness.setChats(1);
  await assert.rejects(harness.call("review:export", { review, formats: ["JSON"], mode: "draft" }), /正在运行/);
  harness.setChats(0);
  harness.call("review:delete-task", { projectId: "one" });
  await assert.rejects(harness.call("review:export", { review, formats: ["JSON"], mode: "draft" }), /已被删除/);
});

test("取消导出目录不写入导出记录", async () => {
  const harness = createHarness();
  const review = { project: { project_id: "one", file_version_id: "v1", contract_type: "other" }, document: { text: "test" }, risks: [] };
  const before = harness.storage.loadState();
  const result = await harness.call("review:export", { review, formats: ["JSON"], mode: "draft" });
  assert.equal(result.validation.cancelled, true);
  assert.equal(result.records.length, 0);
  assert.deepEqual(harness.storage.loadState(), before);
});

test("导出旧快照只追加记录，不能覆盖较新的复核结果或丢失之前的导出记录", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-snapshot-ipc-"));
  const harness = createHarness(undefined, async () => ({ canceled: false, filePaths: [outputDir] }));
  const stale = { project: { project_id: "one", file_version_id: "v1", contract_type: "other" }, document: { text: "test" }, risks: [], review_version_id: "old-review" };
  const current = harness.storage.loadState();
  current.reviews.one = { ...stale, review_version_id: "new-review", exportRecords: [{ export_id: "previous-export" }], note: "new human decision" };
  harness.storage.saveState(current);
  const result = await harness.call("review:export", { review: stale, formats: ["JSON"], mode: "draft" });
  assert.equal(result.state.reviews.one.review_version_id, "new-review");
  assert.equal(result.state.reviews.one.note, "new human decision");
  assert.equal(result.state.reviews.one.exportRecords.length, 2);
  assert.equal(result.records[0].review_version_id, "old-review");
});
