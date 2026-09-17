const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createStorage } = require("../electron/storage.cjs");

// 与 task-deletion-ipc.test.cjs 同构的主进程装载器，区别是这里把真实的审查编排接进 IPC，
// 以便验证“停止审查”确实中断模型调用并把 cancelled 终态写回本地状态。
function createHarness(modelInvoker) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-cancel-ipc-"));
  const storage = createStorage(rootDir);
  const handlers = new Map();
  const mainPath = path.resolve(__dirname, "../electron/main.cjs");
  const realRequire = createRequire(mainPath);
  class Window {
    loadFile() {}
    loadURL() {}
    isDestroyed() { return true; }
    webContents = { send() {} };
  }
  vm.runInNewContext(fs.readFileSync(mainPath, "utf8"), {
    require(name) {
      if (name === "electron") return {
        app: { disableHardwareAcceleration() {}, getPath: () => rootDir, whenReady: () => ({ then: (ready) => ready() }), on() {} },
        BrowserWindow: Window,
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
      };
      if (name === "./model-gateway.cjs") return { ...realRequire(name), invokeModel: modelInvoker };
      if (name === "./credential-store.cjs") return { createCredentialStore: () => ({}) };
      if (name === "./review-chat.cjs") return { createReviewChatService: () => ({ activeRequestCount: () => 0 }) };
      return realRequire(name);
    },
    module: { exports: {} },
    __dirname: path.dirname(mainPath),
    process: { env: {}, platform: "win32" },
    // vm 沙箱默认不继承宿主全局对象，主进程使用的 AbortController 需要显式注入。
    AbortController,
    AbortSignal
  }, { filename: mainPath });
  return { storage, call: (channel, options) => handlers.get(channel)(null, options) };
}

const ANALYSIS_MODEL = {
  configId: "cfg-analysis",
  name: "analysis-model",
  modelId: "test-analysis",
  role: "analysis",
  status: "active",
  testStatus: "passed",
  endpoint: "http://127.0.0.1:1/v1/chat/completions",
  contextLength: 16000,
  maxTokens: 2048
};

function seedProject(storage) {
  storage.saveState({
    activeProjectId: "one",
    projects: [{ project_id: "one", project_name: "待停止的采购合同" }],
    reviews: {
      one: {
        project: { project_id: "one", file_version_id: "contract_v1", contract_type: "procurement" },
        document: {
          documentType: "docx",
          fileVersionId: "contract_v1",
          text: "第四条 付款\n预付款 40%。",
          sha256: "hash-ipc-cancel",
          pages: [{ page: 1, text: "第四条 付款\n预付款 40%。" }]
        },
        config: { snapshot: { id: "", status: "draft" }, rules: ["payment-rules"], policies: [] },
        task: { task_id: "task_one", status: "queued", progress: 0 },
        risks: []
      }
    },
    knowledge: {
      legalSnapshots: [],
      rules: [{ file: "payment-rules", selected: true, clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款比例不得超过 30%" }] }],
      policies: []
    },
    capabilities: { models: [ANALYSIS_MODEL], skills: [] },
    settings: {}
  });
}

test("审查停止 IPC 中断正在运行的模型调用，并把已生成风险随 cancelled 状态保存", async () => {
  let modelStarted;
  const started = new Promise((resolve) => { modelStarted = resolve; });
  const harness = createHarness(async (options) => {
    modelStarted();
    // 真实的模型网关在收到中断信号后会返回取消码；这里复现同一契约。
    await new Promise((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", resolve, { once: true });
    });
    return { ok: false, errorCode: "MODEL_REQUEST_CANCELLED", message: "模型请求已取消", attempts: 1 };
  });
  seedProject(harness.storage);
  const review = harness.storage.loadState().reviews.one;

  const running = harness.call("review:run", { projectId: "one", review, runId: "run-cancel-1" });
  await started;
  const cancelled = await harness.call("review:cancel", { projectId: "one" });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, "cancelling");

  const result = await running;
  assert.equal(result.review.task.status, "cancelled");
  assert.ok(result.review.risks.length > 0, "停止后已生成的候选风险必须保留");
  assert.ok(result.review.check_results.length > 0, "已执行的确定性检查必须保留");
  assert.match(result.review.review_version_id, /-CANCELLED-/);

  const stored = harness.storage.loadState();
  assert.equal(stored.reviews.one.task.status, "cancelled");
  assert.equal(stored.reviews.one.risks.length, result.review.risks.length);
  const audit = stored.auditRecords.find((entry) => entry.action === "执行合同审查");
  assert.equal(audit.result, "已取消");
  assert.match(audit.detail, /cancelled/);
});

test("停止 IPC 对未运行的项目不改动状态，也不中断其它任务", async () => {
  const harness = createHarness(async () => ({ ok: false, errorCode: "MODEL_CONFIG_INVALID", message: "不应被调用" }));
  seedProject(harness.storage);
  const before = JSON.stringify(harness.storage.loadState());

  const idle = await harness.call("review:cancel", { projectId: "one" });
  assert.equal(idle.ok, false);
  assert.equal(idle.status, "not_running");
  assert.equal(JSON.stringify(harness.storage.loadState()), before);

  const unknown = await harness.call("review:cancel", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "not_running");
});
