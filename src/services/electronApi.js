// 所有渲染层本地能力都从这里经过，组件不直接访问 Node.js 或文件系统。
const bridge = typeof window !== "undefined" ? window.contractApp : null;

function readBrowserState() {
  try {
    return JSON.parse(window.localStorage.getItem("contract-review-state") || "null");
  } catch (_error) {
    return null;
  }
}

export const hasElectronBridge = Boolean(bridge);

export const electronApi = {
  selectContractFile() {
    return bridge?.selectContractFile ? bridge.selectContractFile() : Promise.resolve(null);
  },
  importContract(options) {
    if (!bridge?.importContract) return Promise.reject(new Error("当前页面未连接 Electron 文件导入能力"));
    return bridge.importContract(options);
  },
  loadState() {
    return bridge?.loadState ? bridge.loadState() : Promise.resolve(readBrowserState());
  },
  saveState(state) {
    if (bridge?.saveState) return bridge.saveState(state);
    window.localStorage.setItem("contract-review-state", JSON.stringify(state));
    return Promise.resolve(state);
  },
  validateExport(payload) {
    if (!bridge?.validateExport) {
      return Promise.resolve({
        canExport: false,
        items: [{ id: "bridge", label: "Electron 本地能力", status: "failed", code: "ELECTRON_BRIDGE_UNAVAILABLE", message: "浏览器预览未连接本地 Validator", suggestion: "请通过 Electron 桌面端执行导出" }],
        blockingCodes: ["ELECTRON_BRIDGE_UNAVAILABLE"]
      });
    }
    return bridge.validateExport(payload);
  },
  exportReview(payload) {
    if (!bridge?.exportReview) return Promise.reject(new Error("当前页面未连接 Electron 导出能力"));
    return bridge.exportReview(payload);
  }
};
