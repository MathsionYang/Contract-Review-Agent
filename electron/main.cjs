const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { createStorage } = require("./storage.cjs");
const { parseContract } = require("./parser.cjs");
const { validateReview } = require("./validator.cjs");
const { exportReview } = require("./exporter.cjs");

let mainWindow;
let storage;

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

function mergeAudit(state, entry) {
  const next = state && typeof state === "object" ? state : {};
  next.auditRecords = Array.isArray(next.auditRecords) ? next.auditRecords : [];
  next.auditRecords.unshift(entry);
  return next;
}

function registerIpc() {
  ipcMain.handle("contract:select-file", chooseContractFile);

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
        snapshot: { id: "CN-2026-09", status: "published" },
        rules: ["contract-common@1.0"],
        policies: []
      },
      task: {
        task_id: `task_${projectId}`,
        status: "waiting_confirmation",
        progress: 16,
        checkpoint_id: `ckpt_${Date.now()}`,
        idempotency_key: `idem_${parsed.sha256.slice(0, 16)}`
      }
    };
    const current = storage.loadState();
    const nextState = {
      ...current,
      activeProjectId: projectId,
      projects: [...(current.projects || []).filter((item) => item.project_id !== projectId), project],
      reviews: { ...(current.reviews || {}), [projectId]: review },
      auditRecords: [
        auditEntry("导入合同", parsed.fileName, "成功", `${parsed.documentType} · ${parsed.pageCount} 页 · ${parsed.sha256}`)
      ].concat(current.auditRecords || [])
    };
    storage.saveState(nextState);
    return { state: nextState, project, review };
  });

  ipcMain.handle("state:load", () => storage.loadState());
  ipcMain.handle("state:save", (_event, state) => storage.saveState(state));

  ipcMain.handle("review:validate-export", (_event, payload = {}) => {
    return validateReview(payload.review || payload, { formats: payload.formats || [] });
  });

  ipcMain.handle("review:export", async (_event, payload = {}) => {
    const review = payload.review || payload;
    const requestedFormats = Array.isArray(payload.formats) ? payload.formats : [];
    const validation = validateReview(review, { formats: requestedFormats });
    if (!validation.canExport) {
      const state = storage.loadState();
      const nextState = mergeAudit(state, auditEntry(
        "导出审查结果",
        review.project?.project_id || "unknown-project",
        "EXPORT_BLOCKED",
        validation.blockingCodes.join(",")
      ));
      storage.saveState(nextState);
      return { records: [], validation, state: nextState };
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

    const result = await exportReview({
      review,
      formats: requestedFormats,
      outputDir: picked.filePaths[0]
    });
    let state = storage.loadState();
    state = {
      ...state,
      activeProjectId: review.project?.project_id || state.activeProjectId,
      reviews: { ...(state.reviews || {}), [review.project?.project_id]: review },
      auditRecords: [
        auditEntry(
          "导出审查结果",
          review.project?.project_id || "unknown-project",
          "成功",
          result.records.map((item) => item.format).join(",")
        )
      ].concat(state.auditRecords || [])
    };
    state.reviews[review.project?.project_id] = {
      ...review,
      exportRecords: [...(review.exportRecords || []), ...result.records]
    };
    storage.saveState(state);
    return { ...result, state };
  });
}

app.whenReady().then(() => {
  storage = createStorage(app.getPath("userData"));
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
