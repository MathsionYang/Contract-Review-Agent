const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { createStorage } = require("./storage.cjs");
const { parseContract } = require("./parser.cjs");
const { validateReview } = require("./validator.cjs");
const { exportReview } = require("./exporter.cjs");
const { buildKnowledgeItem, parseKnowledgeFile, parseLegalSnapshotFile, validateKnowledgeFile } = require("./knowledge.cjs");
const { runReview } = require("./review-runner.cjs");
const { verifyLegalSource } = require("./legal-source.cjs");
const { createReviewChatService } = require("./review-chat.cjs");
const { createCredentialStore } = require("./credential-store.cjs");
const { invokeModel, testModelConnection } = require("./model-gateway.cjs");
const { createVectorCache } = require("./knowledge-retrieval.cjs");
const { deleteKnowledgeEntries } = require("../src/services/knowledgeManagement.mjs");
const { applyModelUpdate } = require("../src/services/modelState.mjs");

let mainWindow;
let storage;
let reviewChatService;
let credentialStore;
const runningReviewProjects = new Set();
// 每个正在运行的审查任务保留一个中断控制器，用户点击“停止审查”时立即中断模型与检索调用。
const runningReviewControllers = new Map();

// 审查工作台不依赖 GPU；关闭硬件加速可兼容受限桌面、远程会话和无可用显卡驱动环境。
app.disableHardwareAcceleration();

function isDevelopment() {
  return Boolean(process.env.VITE_DEV_SERVER_URL);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f4f6fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDevelopment()) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function auditEntry(action, resource, result, detail = "") {
  return {
    audit_id: `audit_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    created_at: new Date().toISOString(),
    actor: "本地法务用户",
    action,
    resource,
    result,
    detail
  };
}

// 只传递归一化后的单条风险和任务进度，不发送原始模型流或完整合同。
function sendReviewProgress(projectId, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("review:progress", {
    projectId,
    step: String(progress?.step || ""),
    progress: Math.min(Math.max(Number(progress?.progress) || 0, 0), 100),
    status: String(progress?.status || "running"),
    riskCount: Math.max(0, Number(progress?.riskCount) || 0),
    runId: progress.runId,
    sequence: progress.sequence,
    fileVersionId: progress.fileVersionId,
    ...(progress.executionSummary ? { executionSummary: progress.executionSummary } : {}),
    ...(progress.riskUpdate ? { riskUpdate: progress.riskUpdate } : {})
  });
}

function sendChatEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("review:chat-event", payload);
}

async function chooseContractFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择合同文件",
    properties: ["openFile"],
    filters: [
      { name: "合同文件", extensions: ["docx", "pdf"] },
      { name: "全部文件", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
}

async function chooseKnowledgeFiles(kind) {
  const title = kind === "rules" ? "选择确定性规则文件" : kind === "policies" ? "选择企业制度文件" : "选择法律快照文件";
  const extensions = kind === "legalSnapshots" ? ["json", "md", "txt"] : ["docx", "pdf", "md", "txt", "json"];
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "知识文件", extensions }, { name: "全部文件", extensions: ["*"] }]
  });
  if (result.canceled) return { canceled: true, files: [] };
  return { canceled: false, files: result.filePaths.map((filePath) => ({ filePath, fileName: path.basename(filePath) })) };
}

function ensureKnowledgeState(state) {
  state.knowledge = state.knowledge && typeof state.knowledge === "object" ? state.knowledge : {};
  state.knowledge.rules = Array.isArray(state.knowledge.rules) ? state.knowledge.rules : [];
  state.knowledge.policies = Array.isArray(state.knowledge.policies) ? state.knowledge.policies : [];
  state.knowledge.legalSnapshots = Array.isArray(state.knowledge.legalSnapshots) ? state.knowledge.legalSnapshots : [];
  state.knowledge.memory = Array.isArray(state.knowledge.memory) ? state.knowledge.memory : [];
  return state;
}

// 首次启动时主进程状态可能还没有治理配置，只接收渲染层的三个配置域，避免覆盖主进程项目和审计数据。
function mergeBootstrapContext(state, bootstrapState) {
  const next = state && typeof state === "object" ? state : {};
  const context = bootstrapState && typeof bootstrapState === "object" ? bootstrapState : {};
  for (const key of ["knowledge", "capabilities", "settings"]) {
    if (next[key] === undefined && context[key] !== undefined) next[key] = context[key];
  }
  return next;
}

function relativeStoragePath(filePath) {
  return path.relative(storage.rootDir, filePath).split(path.sep).join("/");
}

async function importKnowledgeFile(filePath, kind, options = {}) {
  const metadata = validateKnowledgeFile(filePath, kind);
  const parsed = await parseKnowledgeFile(metadata.filePath, kind);
  const versionId = `${kind}_${metadata.sha256.slice(0, 16)}`;
  const saved = storage.saveKnowledgeFile({ kind, versionId, sourcePath: metadata.filePath, fileName: metadata.fileName });
  return buildKnowledgeItem({
    entry_id: crypto.randomUUID(),
    kind,
    fileName: metadata.fileName,
    summary: options.summary || `${parsed.clauses.length} 个可检索条款 · ${metadata.sha256.slice(0, 12)}`,
    type: options.type || (kind === "rules" ? "导入规则" : "企业制度"),
    version: options.version || "v1.0",
    priority: options.priority || "high",
    status: kind === "rules" ? "active" : "published",
    selected: false,
    fileVersionId: versionId,
    sourcePathRef: relativeStoragePath(saved.storedPath),
    size: saved.sizeBytes,
    sha256: saved.sha256,
    clauses: parsed.clauses,
    text: parsed.text,
    parseStatus: parsed.parseStatus
  });
}

function mergeAudit(state, entry) {
  const next = state && typeof state === "object" ? state : {};
  next.auditRecords = Array.isArray(next.auditRecords) ? next.auditRecords : [];
  next.auditRecords.unshift(entry);
  return next;
}

// 凭据只在主进程内解密，并在调用模型时通过 resolver 注入，绝不返回给渲染层或写入业务状态。
function runModelWithCredential(options = {}) {
  const model = options.model || {};
  const reference = String(model.credentialRef || "").trim();
  const credential = reference && reference !== "none" && credentialStore
    ? credentialStore.get(reference)
    : "";
  return invokeModel({
    ...options,
    credentialResolver: () => credential
  });
}

function registerIpc() {
  const invokeConfiguredModel = (options = {}) => runModelWithCredential(options);
  const vectorCache = createVectorCache(path.join(storage.rootDir, "cache", "embeddings"));
  reviewChatService = createReviewChatService({
    storage,
    sendEvent: sendChatEvent,
    invokeModel: invokeConfiguredModel,
    vectorCache
  });
  ipcMain.handle("model:test-connection", async (_event, options = {}) => {
    const candidates = (storage.loadState().capabilities?.models || []).filter((item) => item.configId === options.configId);
    if (!options.configId || candidates.length !== 1) throw new Error("模型配置不存在，请保存后再测试");
    if (options.expectedRevision !== undefined && (candidates[0].configRevision || "") !== options.expectedRevision) throw new Error("模型配置已更新，请重新测试");
    return testModelConnection({ model: candidates[0], invokeModel: invokeConfiguredModel });
  });
  ipcMain.handle("model:update", (_event, payload = {}) => {
    const saved = storage.saveState(applyModelUpdate(storage.loadState(), payload));
    return { model: saved.capabilities.models.find((item) => item.configId === payload.configId) || null, auditRecord: payload.auditRecord };
  });
  ipcMain.handle("contract:select-file", chooseContractFile);

  ipcMain.handle("knowledge:select-files", (_event, options = {}) => chooseKnowledgeFiles(options.kind || "policies"));

  ipcMain.handle("knowledge:delete", (_event, options = {}) => {
    if (runningReviewProjects.size || reviewChatService.activeRequestCount()) throw new Error("审查或对话正在运行，请稍后删除知识记录");
    const state = ensureKnowledgeState(mergeBootstrapContext(storage.loadState(), options.bootstrapState));
    return storage.saveState(deleteKnowledgeEntries(state, options.kind, options.keys));
  });

  ipcMain.handle("knowledge:import-files", async (_event, options = {}) => {
    if (runningReviewProjects.size || reviewChatService.activeRequestCount()) throw new Error("审查或对话正在运行，请稍后导入");
    const kind = options.kind;
    const files = Array.isArray(options.files) ? options.files : [];
    if (!["rules", "policies"].includes(kind)) throw new Error("只能导入确定性规则或企业制度文件");
    let state = ensureKnowledgeState(mergeBootstrapContext(storage.loadState(), options.bootstrapState));
    const items = [];
    const errors = [];
    for (const file of files) {
      try {
        const item = await importKnowledgeFile(file.filePath, kind, file);
        if (state.knowledge[kind].some((current) => current.sha256 && current.sha256 === item.sha256)) continue;
        state.knowledge[kind].unshift(item);
        items.push(item);
        state.auditRecords.unshift(auditEntry(
          kind === "rules" ? "上传确定性规则" : "上传企业制度",
          item.file,
          "成功",
          `${item.file_version_id} · ${item.clauses.length} 个条款`
        ));
      } catch (error) {
        errors.push({ fileName: file.fileName || path.basename(file.filePath || ""), code: error.code || "KNOWLEDGE_PARSE_FAILED", message: error.message });
      }
    }
    return { items, errors, state: storage.saveState(state) };
  });

  ipcMain.handle("legal:import-snapshot", async (_event, options = {}) => {
    if (runningReviewProjects.size || reviewChatService.activeRequestCount()) throw new Error("审查或对话正在运行，请稍后导入");
    let filePath = options.filePath;
    if (!filePath) {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "导入法律快照",
        properties: ["openFile"],
        filters: [{ name: "法律快照", extensions: ["json", "md", "txt"] }]
      });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true, state: storage.loadState() };
      filePath = selected.filePaths[0];
    }
    const parsed = await parseLegalSnapshotFile(filePath);
    let state = ensureKnowledgeState(mergeBootstrapContext(storage.loadState(), options.bootstrapState));
    if (state.knowledge.legalSnapshots.some((snapshot) => snapshot.id === parsed.id)) {
      const error = new Error("同 ID 法律快照已经存在");
      error.code = "LEGAL_SNAPSHOT_DUPLICATE";
      throw error;
    }
    const saved = storage.saveKnowledgeFile({
      kind: "legalSnapshots",
      versionId: parsed.fileVersionId,
      sourcePath: parsed.sourcePath,
      fileName: parsed.fileName
    });
    const snapshot = { ...parsed, entry_id: crypto.randomUUID(), source_path_ref: relativeStoragePath(saved.storedPath) };
    delete snapshot.sourcePath;
    state.knowledge.legalSnapshots.unshift(snapshot);
    state.auditRecords.unshift(auditEntry("导入法律快照", snapshot.id, "成功", `${snapshot.name} · ${snapshot.clauses.length} 个条款`));
    return { canceled: false, snapshot, state: storage.saveState(state) };
  });

  ipcMain.handle("legal:verify-realtime", async (_event, options = {}) => {
    const state = storage.loadState();
    const result = await verifyLegalSource({
      url: options.url,
      query: options.query,
      allowlist: state.settings?.legalSourceAllowlist || [],
      timeoutMs: options.timeoutMs
    });
    const nextState = ensureKnowledgeState(state);
    nextState.auditRecords.unshift(auditEntry("实时法律来源核验", options.query || "未填写查询", result.status === "verified" ? "成功" : result.errorCode || "未完成", result.message || ""));
    return { ...result, state: storage.saveState(nextState) };
  });

  ipcMain.handle("review:run", async (_event, options = {}) => {
    const stored = ensureKnowledgeState(storage.loadState());
    const projectId = options.projectId || options.review?.project?.project_id || stored.activeProjectId;
    if (stored.deletedProjectIds?.includes(projectId)) throw new Error("审查任务已被删除");
    if (runningReviewProjects.has(projectId)) throw new Error("该审查任务正在运行");
    const review = options.review || stored.reviews?.[projectId];
    if (!review) throw new Error("当前项目没有可执行的审查版本");
    const runId = typeof options.runId === "string" && options.runId.length <= 100 ? options.runId : crypto.randomUUID();
    let sequence = 0;
    const controller = new AbortController();
    runningReviewProjects.add(projectId);
    runningReviewControllers.set(projectId, controller);
    try {
      const result = await runReview({
        review,
        state: stored,
        services: { invokeModel: invokeConfiguredModel, vectorCache, signal: controller.signal },
        onProgress: (progress) => sendReviewProgress(projectId, { ...progress, runId, sequence: ++sequence, fileVersionId: review.project?.file_version_id })
      });
      const latest = storage.loadState();
      const statusResult = result.review.task.status;
      const auditResult = statusResult === "completed" ? "成功" : statusResult === "cancelled" ? "已取消" : "部分完成";
      const nextState = {
        ...latest,
        activeProjectId: projectId,
        projects: (latest.projects || []).map((project) => project.project_id === projectId ? { ...project, updated_at: new Date().toISOString() } : project),
        reviews: { ...(latest.reviews || {}), [projectId]: result.review },
        auditRecords: [auditEntry("执行合同审查", projectId, auditResult, `${result.review.risks.length} 条风险 · ${statusResult}`), ...(latest.auditRecords || [])]
      };
      return { ...result, state: storage.saveState(nextState) };
    } finally {
      runningReviewProjects.delete(projectId);
      runningReviewControllers.delete(projectId);
    }
  });

  // 只中断当前项目的审查任务：已发布的候选风险会随最终状态一起保存，未被中断的其它任务不受影响。
  ipcMain.handle("review:cancel", (_event, options = {}) => {
    const projectId = String(options.projectId || "");
    const controller = projectId ? runningReviewControllers.get(projectId) : null;
    if (!controller) return { ok: false, status: "not_running", message: "当前没有正在运行的审查任务" };
    controller.abort();
    return { ok: true, status: "cancelling" };
  });

  ipcMain.handle("review:delete-task", (_event, options = {}) => {
    if (runningReviewProjects.size || reviewChatService.activeRequestCount()) {
      throw new Error("审查或对话正在运行，请等待完成后再删除任务");
    }
    return storage.deleteTask(options.projectId);
  });

  ipcMain.handle("review:chat", async (_event, options = {}) => reviewChatService.chat(options));
  ipcMain.handle("review:chat-retry", async (_event, options = {}) => reviewChatService.retry(options));
  ipcMain.handle("review:chat-cancel", (_event, options = {}) => reviewChatService.cancel(options));
  ipcMain.handle("review:memory-confirm", (_event, options = {}) => reviewChatService.confirmMemory(options));
  ipcMain.handle("review:memory-dismiss", (_event, options = {}) => reviewChatService.dismissMemory(options));

  ipcMain.handle("credential:save", (_event, options = {}) => {
    const reference = String(options.reference || "").trim();
    const apiKey = String(options.apiKey || "").trim();
    if (!apiKey) return { configured: credentialStore.has(reference) };
    return credentialStore.save(reference, apiKey);
  });
  ipcMain.handle("credential:status", (_event, options = {}) => ({
    configured: credentialStore.has(options.reference)
  }));

  ipcMain.handle("contract:import", async (_event, options = {}) => {
    const filePath = options.filePath;
    const parsed = await parseContract(filePath);
    const projectId = `project_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const reviewVersionId = `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-01`;
    const fileVersionId = `contract_v1`;
    const savedFile = storage.saveProjectFile({
      projectId,
      versionId: fileVersionId,
      sourcePath: filePath,
      fileName: parsed.fileName
    });
    const project = {
      project_id: projectId,
      project_name: options.projectName || parsed.fileName.replace(/\.[^.]+$/, ""),
      file_name: parsed.fileName,
      stored_path: savedFile.storedPath,
      file_version_id: fileVersionId,
      contract_type: options.contractType || "other",
      review_mode: options.reviewMode || "standard",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const review = {
      review_version_id: reviewVersionId,
      project,
      document: parsed,
      risks: [],
      annotations: [],
      humanRevisions: [],
      exportRecords: [],
      config: {
        snapshot: { id: "", status: "draft" },
        rules: [],
        policies: []
      },
      task: {
        task_id: `task_${projectId}`,
        status: "queued",
        current_step: "parse",
        progress: 0,
        checkpoint_id: `ckpt_${Date.now()}`,
        idempotency_key: `idem_${parsed.sha256.slice(0, 16)}`,
        errors: []
      }
    };
    const current = ensureKnowledgeState(mergeBootstrapContext(storage.loadState(), options.bootstrapState));
    const publishedSnapshot = current.knowledge.legalSnapshots.find((snapshot) => snapshot.status === "published");
    review.config.snapshot = publishedSnapshot ? { id: publishedSnapshot.id, status: publishedSnapshot.status } : review.config.snapshot;
    review.config.rules = current.knowledge.rules.filter((item) => item.selected && item.status === "active").map((item) => item.file);
    review.config.policies = current.knowledge.policies.filter((item) => item.selected && item.status === "published").map((item) => item.file);
    const nextState = {
      ...current,
      activeProjectId: projectId,
      projects: [...(current.projects || []).filter((item) => item.project_id !== projectId), project],
      reviews: { ...(current.reviews || {}), [projectId]: review },
      auditRecords: [
        auditEntry("导入合同", parsed.fileName, "成功", `${parsed.documentType} · ${parsed.pageCount} 页 · ${parsed.sha256}`)
      ].concat(current.auditRecords || [])
    };
    return { state: storage.saveState(nextState), project, review };
  });

  ipcMain.handle("state:load", () => storage.loadState());
  ipcMain.handle("state:save", (_event, state) => storage.saveState(state));

  ipcMain.handle("review:validate-export", (_event, payload = {}) => {
    return validateReview(payload.review || payload, { formats: payload.formats || [], mode: payload.mode });
  });

  ipcMain.handle("review:export", async (_event, payload = {}) => {
    const review = payload.review || payload;
    const assertExportAvailable = () => {
      if (runningReviewProjects.size || reviewChatService.activeRequestCount()) throw new Error("审查或对话正在运行，请等待完成后再导出");
      if (storage.loadState().deletedProjectIds?.includes(review.project?.project_id)) throw new Error("审查任务已被删除，无法导出");
    };
    assertExportAvailable();
    const requestedFormats = Array.isArray(payload.formats) ? payload.formats : [];
    const mode = payload.mode === undefined ? "formal" : payload.mode;
    const validation = validateReview(review, { formats: requestedFormats, mode });
    if (!validation.canExport) {
      const state = storage.loadState();
      const nextState = mergeAudit(state, auditEntry(
        "导出审查结果",
        review.project?.project_id || "unknown-project",
        "EXPORT_BLOCKED",
        `${mode} · ${validation.blockingCodes.join(",")}`
      ));
      return { records: [], validation, state: storage.saveState(nextState) };
    }

    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "选择导出目录",
      properties: ["openDirectory", "createDirectory"]
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return {
        records: [],
        validation: { ...validation, cancelled: true },
        state: storage.loadState()
      };
    }

    assertExportAvailable();
    const result = await exportReview({
      review,
      formats: requestedFormats,
      mode,
      outputDir: picked.filePaths[0]
    });
    let state = storage.loadState();
    const currentReview = state.reviews?.[review.project?.project_id] || review;
    state = {
      ...state,
      activeProjectId: review.project?.project_id || state.activeProjectId,
      reviews: { ...(state.reviews || {}) },
      auditRecords: [
        auditEntry(
          "导出审查结果",
          review.project?.project_id || "unknown-project",
          mode === "draft" ? "草稿已生成" : "正式报告已生成",
          `${result.records.map((item) => item.format).join(",")} · ${mode} · 待核验代码：${result.validation.warningCodes.join(",") || "无"}`
        )
      ].concat(state.auditRecords || [])
    };
    state.reviews[review.project?.project_id] = {
      ...currentReview,
      exportRecords: [...(currentReview.exportRecords || []), ...result.records]
    };
    return { ...result, state: storage.saveState(state) };
  });
}

app.whenReady().then(() => {
  storage = createStorage(app.getPath("userData"));
  credentialStore = createCredentialStore(app.getPath("userData"), safeStorage);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = { createWindow, auditEntry };
