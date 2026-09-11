// 所有渲染层本地能力都从这里经过，组件不直接访问 Node.js 或文件系统。
import { toCloneable } from "./clonePayload.mjs";

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
    return bridge.importContract(toCloneable(options));
  },
  selectKnowledgeFiles(kind) {
    if (!bridge?.selectKnowledgeFiles) return Promise.reject(new Error("当前页面未连接 Electron 知识文件选择能力"));
    return bridge.selectKnowledgeFiles(kind);
  },
  importKnowledgeFiles(payload) {
    if (!bridge?.importKnowledgeFiles) return Promise.reject(new Error("当前页面未连接 Electron 知识文件导入能力"));
    return bridge.importKnowledgeFiles(toCloneable(payload));
  },
  importLegalSnapshot(payload) {
    if (!bridge?.importLegalSnapshot) return Promise.reject(new Error("当前页面未连接 Electron 法律快照导入能力"));
    return bridge.importLegalSnapshot(toCloneable(payload));
  },
  verifyLegalRealtime(payload) {
    if (!bridge?.verifyLegalRealtime) return Promise.reject(new Error("当前页面未连接 Electron 法律来源核验能力"));
    return bridge.verifyLegalRealtime(toCloneable(payload));
  },
  runReview(payload) {
    if (!bridge?.runReview) return Promise.reject(new Error("当前页面未连接 Electron 审查执行能力"));
    return bridge.runReview(toCloneable(payload));
  },
  onReviewProgress(callback) {
    if (!bridge?.onReviewProgress) return () => {};
    return bridge.onReviewProgress(callback);
  },
  chatReview(payload) {
    if (!bridge?.chatReview) return Promise.reject(new Error("当前页面未连接 Electron 对话审核能力"));
    return bridge.chatReview(toCloneable(payload));
  },
  retryChat(payload) {
    if (!bridge?.retryChat) return Promise.reject(new Error("当前页面未连接 Electron 对话重试能力"));
    return bridge.retryChat(toCloneable(payload));
  },
  cancelChat(payload) {
    if (!bridge?.cancelChat) return Promise.reject(new Error("当前页面未连接 Electron 对话取消能力"));
    return bridge.cancelChat(toCloneable(payload));
  },
  confirmMemory(payload) {
    if (!bridge?.confirmMemory) return Promise.reject(new Error("当前页面未连接企业记忆确认能力"));
    return bridge.confirmMemory(toCloneable(payload));
  },
  dismissMemory(payload) {
    if (!bridge?.dismissMemory) return Promise.reject(new Error("当前页面未连接企业记忆放弃能力"));
    return bridge.dismissMemory(toCloneable(payload));
  },
  onChatEvent(callback) {
    if (!bridge?.onChatEvent) return () => {};
    return bridge.onChatEvent(callback);
  },
  loadState() {
    return bridge?.loadState ? bridge.loadState() : Promise.resolve(readBrowserState());
  },
  saveState(state) {
    const plainState = toCloneable(state);
    if (bridge?.saveState) return bridge.saveState(plainState);
    window.localStorage.setItem("contract-review-state", JSON.stringify(plainState));
    return Promise.resolve(plainState);
  },
  validateExport(payload) {
    if (!bridge?.validateExport) {
      return Promise.resolve({
        canExport: false,
        items: [{ id: "bridge", label: "Electron 本地能力", status: "failed", code: "ELECTRON_BRIDGE_UNAVAILABLE", message: "浏览器预览未连接本地 Validator", suggestion: "请通过 Electron 桌面端执行导出" }],
        blockingCodes: ["ELECTRON_BRIDGE_UNAVAILABLE"]
      });
    }
    return bridge.validateExport(toCloneable(payload));
  },
  exportReview(payload) {
    if (!bridge?.exportReview) return Promise.reject(new Error("当前页面未连接 Electron 导出能力"));
    return bridge.exportReview(toCloneable(payload));
  }
};
