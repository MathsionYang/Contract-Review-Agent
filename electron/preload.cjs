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
