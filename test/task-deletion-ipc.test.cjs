const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createStorage } = require("../electron/storage.cjs");

function createHarness(runReview = async ({ review }) => ({ review }), chooseDirectory = async () => ({ canceled: true }), modelInvoker = null) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-delete-ipc-"));
  const storage = createStorage(rootDir);
  const handlers = new Map();
  const events = [];
  let chats = 0;
  const mainPath = path.resolve(__dirname, "../electron/main.cjs");
  const realRequire = createRequire(mainPath);
  class Window {
    loadFile() {}
    loadURL() {}
    isDestroyed() { return false; }
    webContents = { send: (channel, payload) => events.push({ channel, payload }) };
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
      if (name === "./model-gateway.cjs" && modelInvoker) return { ...realRequire(name), invokeModel: modelInvoker };
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
  return { storage, initial, events, call: (channel, options) => handlers.get(channel)(null, options), setChats: (count) => { chats = count; } };
}

test("连通性测试 IPC 只使用已保存的目标模型，不接受渲染层伪造配置", async () => {
  const calls = [];
  const harness = createHarness(undefined, undefined, async (request) => {
    calls.push(request);
    return { ok: true, data: request.model.role === "embedding" ? { vectors: [[1, 0]] } : { ok: true } };
  });
  const state = harness.storage.loadState();
  state.capabilities = { models: [
    { configId: "embed", name: "same", role: "embedding", modelId: "vector", endpoint: "https://saved.invalid/v1", credentialRef: "none" },
    { configId: "extract", name: "same", role: "extraction", modelId: "extract", endpoint: "https://saved.invalid/v1", credentialRef: "none" }
  ] };
  harness.storage.saveState(state);
  const result = await harness.call("model:test-connection", { configId: "embed", model: { endpoint: "https://injected.invalid" } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].model.modelId, "vector");
  assert.equal(calls[0].model.endpoint, "https://saved.invalid/v1");
  assert.equal(calls[0].operation, "embedding");
  assert.equal(result.data, undefined);
  await assert.rejects(harness.call("model:test-connection", { configId: "missing" }), /模型配置不存在/);
  assert.equal(calls.length, 1);
});

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

test("模型独立更新和连接测试可与审查、对话并行，不覆盖执行快照或其他配置", async () => {
  let finish;
  let executedState;
  const calls = [];
  const harness = createHarness(({ review, state }) => new Promise((resolve) => {
    executedState = state;
    finish = () => resolve({ review: { ...review, risks: [{ risk_id: "new-risk" }], task: { status: "completed" } } });
  }), undefined, async ({ model }) => { calls.push(model); return { ok: true, data: { ok: true } }; });
  const model = { configId: "m1", configRevision: "v1", name: "模型", modelId: "old", role: "analysis", endpoint: "https://saved.invalid/v1", status: "active", testStatus: "passed" };
  const initial = harness.storage.loadState();
  initial.capabilities = { models: [model, { ...model, configId: "m2" }], skills: [{ name: "skill" }] };
  initial.reviews.one.config = { execution: { models: { analysis: { configId: "m1", modelId: "old" } } } };
  initial.reviews.one.chat_sessions = [{ messages: [{ content: "saved chat" }] }];
  harness.storage.saveState(initial);
  const running = harness.call("review:run", { projectId: "one" });
  harness.setChats(1);
  const edited = { ...model, modelId: "edited", configRevision: "v2", status: "disabled", testStatus: "untested", apiKey: "must-not-save" };
  const saved = harness.call("model:update", { configId: "m1", expectedRevision: "v1", model: edited, auditRecord: { audit_id: "model-edit" }, reviews: {} });
  assert.equal(saved.model.modelId, "edited");
  assert.equal(saved.model.apiKey, undefined);
  assert.deepEqual(harness.storage.loadState().reviews, initial.reviews);
  assert.equal(executedState.capabilities.models[0].modelId, "old");
  assert.equal((await harness.call("model:test-connection", { configId: "m1", expectedRevision: "v2" })).ok, true);
  assert.equal(calls[0].modelId, "edited");
  finish();
  const result = await running;
  assert.equal(result.state.capabilities.models[0].modelId, "edited");
  assert.equal(result.state.capabilities.models[1].configId, "m2");
  assert.equal(result.state.capabilities.skills[0].name, "skill");
  assert.equal(result.review.config.execution.models.analysis.modelId, "old");
  assert.equal(result.review.risks[0].risk_id, "new-risk");
  assert.equal(result.review.chat_sessions[0].messages[0].content, "saved chat");
  assert.ok(result.state.auditRecords.some((entry) => entry.audit_id === "model-edit"));
});

test("过期模型更新和连接测试不能覆盖编辑结果或恢复已删除模型", async () => {
  const calls = [];
  const harness = createHarness(undefined, undefined, async (request) => { calls.push(request); return { ok: true }; });
  const model = { configId: "m1", configRevision: "v1", name: "模型", modelId: "old", role: "analysis", endpoint: "https://saved.invalid/v1" };
  harness.call("model:update", { configId: "m1", expectedRevision: null, model });
  harness.call("model:update", { configId: "m1", expectedRevision: "v1", model: { ...model, configRevision: "v2", modelId: "edited" } });
  assert.throws(() => harness.call("model:update", { configId: "m1", expectedRevision: "v1", model: { ...model, configRevision: "v3", testStatus: "passed" } }), /已更新或删除/);
  await assert.rejects(harness.call("model:test-connection", { configId: "m1", expectedRevision: "v1" }), /已更新/);
  assert.equal(calls.length, 0);
  harness.call("model:update", { configId: "m1", expectedRevision: "v2", model: null });
  assert.throws(() => harness.call("model:update", { configId: "m1", expectedRevision: "v2", model: { ...model, configRevision: "v3" } }), /已更新或删除/);
  assert.equal(harness.storage.loadState().capabilities.models.length, 0);
});

test("法律快照导入和删除真实经过 IPC，取消、重复和运行保护不会误改数据", async () => {
  const { knowledgeItemKey } = require("../src/services/knowledgeManagement.mjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-ipc-"));
  const filePath = path.join(directory, "法律.txt");
  fs.writeFileSync(filePath, "第十条\n测试法律正文。");
  let cancelled = true;
  const harness = createHarness(undefined, async () => ({ canceled: cancelled, filePaths: cancelled ? [] : [filePath] }));
  const initial = JSON.stringify(harness.storage.loadState());
  assert.equal((await harness.call("legal:import-snapshot", {})).canceled, true);
  assert.equal(JSON.stringify(harness.storage.loadState()), initial);
  cancelled = false;
  const imported = await harness.call("legal:import-snapshot", {});
  assert.equal(imported.state.knowledge.legalSnapshots.length, 1);
  assert.equal(imported.snapshot.status, "draft");
  const storedFile = path.join(harness.storage.rootDir, imported.snapshot.source_path_ref);
  assert.equal(fs.readFileSync(storedFile, "utf8"), fs.readFileSync(filePath, "utf8"));
  await assert.rejects(harness.call("legal:import-snapshot", { filePath }), /同 ID/);
  harness.setChats(1);
  assert.throws(() => harness.call("knowledge:delete", { kind: "legalSnapshots", keys: [knowledgeItemKey("legalSnapshots", imported.snapshot)] }), /正在运行/);
  await assert.rejects(harness.call("legal:import-snapshot", { filePath }), /正在运行/);
  harness.setChats(0);
  const removed = harness.call("knowledge:delete", { kind: "legalSnapshots", keys: [knowledgeItemKey("legalSnapshots", imported.snapshot)] });
  assert.equal(removed.knowledge.legalSnapshots.length, 0);
  assert.equal(fs.existsSync(storedFile), true);
  const reimported = await harness.call("legal:import-snapshot", { filePath });
  assert.equal(reimported.state.knowledge.legalSnapshots.length, 1);
  assert.notEqual(reimported.snapshot.entry_id, imported.snapshot.entry_id);
});

test("审查 IPC 逐条转发风险并附带运行 ID、文件版本及递增序号", async () => {
  const harness = createHarness(async ({ review, onProgress }) => {
    onProgress({ step: "rules", progress: 28, riskCount: 0, riskUpdate: { type: "reset" }, rawModelOutput: "must not be exposed" });
    onProgress({ step: "model", progress: 70, riskCount: 1, riskUpdate: { type: "upsert", risk: { risk_id: "r1", contract_location: { file_version_id: "v1" } } } });
    return { review };
  });
  await harness.call("review:run", { projectId: "one", runId: "test-run", review: { ...harness.initial.reviews.one, project: { project_id: "one", file_version_id: "v1" } } });
  const events = harness.events.filter((event) => event.channel === "review:progress").map((event) => event.payload);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.ok(events.every((event) => event.runId === "test-run" && event.fileVersionId === "v1" && event.projectId === "one"));
  assert.equal(events[1].riskUpdate.risk.risk_id, "r1");
  assert.equal(events.some((event) => Object.hasOwn(event, "rawModelOutput")), false);
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
