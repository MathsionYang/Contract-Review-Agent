let contextBridge = null;
let ipcRenderer = null;

if (process.versions.electron) {
  ({ contextBridge, ipcRenderer } = require("electron"));
} else {
  // Node 测试直接加载 preload 时没有 Electron runtime，保留 API 结构即可。
}

// 只向渲染层暴露业务需要的最小接口，避免页面获得 Node.js 能力。
const api = {
  selectContractFile: () => ipcRenderer.invoke("contract:select-file"),
  importContract: (options) => ipcRenderer.invoke("contract:import", options),
  selectKnowledgeFiles: (kind) => ipcRenderer.invoke("knowledge:select-files", { kind }),
  importKnowledgeFiles: (payload) => ipcRenderer.invoke("knowledge:import-files", payload),
  importLegalSnapshot: (payload) => ipcRenderer.invoke("legal:import-snapshot", payload),
  deleteKnowledge: (payload) => ipcRenderer.invoke("knowledge:delete", payload),
  verifyLegalRealtime: (payload) => ipcRenderer.invoke("legal:verify-realtime", payload),
  runReview: (payload) => ipcRenderer.invoke("review:run", payload),
  cancelReview: (payload) => ipcRenderer.invoke("review:cancel", payload),
  deleteReviewTask: (projectId) => ipcRenderer.invoke("review:delete-task", { projectId }),
  chatReview: (payload) => ipcRenderer.invoke("review:chat", payload),
  retryChat: (payload) => ipcRenderer.invoke("review:chat-retry", payload),
  cancelChat: (payload) => ipcRenderer.invoke("review:chat-cancel", payload),
  confirmMemory: (payload) => ipcRenderer.invoke("review:memory-confirm", payload),
  dismissMemory: (payload) => ipcRenderer.invoke("review:memory-dismiss", payload),
  saveCredential: (payload) => ipcRenderer.invoke("credential:save", payload),
  getCredentialStatus: (payload) => ipcRenderer.invoke("credential:status", payload),
  testModelConnection: (payload) => ipcRenderer.invoke("model:test-connection", payload),
  updateModel: (payload) => ipcRenderer.invoke("model:update", payload),
  onChatEvent: (callback) => {
    if (typeof callback !== "function" || !ipcRenderer) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("review:chat-event", listener);
    return () => ipcRenderer.removeListener("review:chat-event", listener);
  },
  onReviewProgress: (callback) => {
    if (typeof callback !== "function" || !ipcRenderer) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("review:progress", listener);
    return () => ipcRenderer.removeListener("review:progress", listener);
  },
  loadState: () => ipcRenderer.invoke("state:load"),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  validateExport: (payload) => ipcRenderer.invoke("review:validate-export", payload),
  exportReview: (payload) => ipcRenderer.invoke("review:export", payload)
};

function exposedApiKeys() {
  return Object.keys(api);
}

if (contextBridge && ipcRenderer) {
  contextBridge.exposeInMainWorld("contractApp", api);
}

module.exports = { api, exposedApiKeys };
