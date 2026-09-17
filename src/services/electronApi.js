// 所有渲染层本地能力都从这里经过，组件不直接访问 Node.js 或文件系统。
import { toCloneable } from "./clonePayload.mjs";
import { deleteReviewTask, reconcileDeletedTasks } from "./reviewTasks.mjs";
import { deleteKnowledgeEntries, reconcileDeletedKnowledge } from "./knowledgeManagement.mjs";
import { applyModelUpdate } from "./modelState.mjs";

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
  async deleteKnowledge(payload) {
    if (bridge) {
      if (!bridge.deleteKnowledge) throw new Error("请重启桌面端以启用知识库删除功能");
      return bridge.deleteKnowledge(toCloneable(payload));
    }
    const state = readBrowserState() || payload.bootstrapState;
    return this.saveState(deleteKnowledgeEntries(state, payload.kind, payload.keys));
  },
  verifyLegalRealtime(payload) {
    if (!bridge?.verifyLegalRealtime) return Promise.reject(new Error("当前页面未连接 Electron 法律来源核验能力"));
    return bridge.verifyLegalRealtime(toCloneable(payload));
  },
  runReview(payload) {
    if (!bridge?.runReview) return Promise.reject(new Error("当前页面未连接 Electron 审查执行能力"));
    return bridge.runReview(toCloneable(payload));
  },
  cancelReview(payload) {
    if (!bridge?.cancelReview) return Promise.resolve({ ok: false, status: "unsupported", message: "请重启桌面端以启用停止审查功能" });
    return bridge.cancelReview(toCloneable(payload));
  },
  async deleteReviewTask(projectId) {
    if (bridge) {
      if (!bridge.deleteReviewTask) throw new Error("请重启桌面端以启用任务删除功能");
      return bridge.deleteReviewTask(projectId);
    }
    const nextState = deleteReviewTask(readBrowserState(), projectId);
    return this.saveState(nextState);
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
  saveCredential(payload) {
    if (!bridge?.saveCredential) return Promise.reject(new Error("当前页面未连接 Electron 本机凭据保存能力"));
    return bridge.saveCredential(toCloneable(payload));
  },
  getCredentialStatus(payload) {
    if (!bridge?.getCredentialStatus) return Promise.resolve({ configured: false });
    return bridge.getCredentialStatus(toCloneable(payload));
  },
  testModelConnection(payload) {
    if (!bridge?.testModelConnection) return Promise.reject(new Error("真实连通性测试需要新版 Electron 桌面端，请重启桌面端"));
    return bridge.testModelConnection(toCloneable(payload));
  },
  async updateModel(payload) {
    const plain = toCloneable(payload);
    if (bridge) {
      if (!bridge.updateModel) throw new Error("请重启桌面端以启用模型配置更新功能");
      return bridge.updateModel(plain);
    }
    const saved = await this.saveState(applyModelUpdate(readBrowserState() || {}, plain));
    return { model: saved.capabilities.models.find((item) => item.configId === plain.configId) || null, auditRecord: plain.auditRecord };
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
    const saved = readBrowserState();
    const nextState = reconcileDeletedKnowledge(reconcileDeletedTasks(plainState, saved), saved);
    window.localStorage.setItem("contract-review-state", JSON.stringify(nextState));
    return Promise.resolve(nextState);
  },
  validateExport(payload) {
    if (!bridge?.validateExport) {
      return Promise.resolve({
        canExport: false,
        mode: payload.mode || "formal",
        warningCodes: [],
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
