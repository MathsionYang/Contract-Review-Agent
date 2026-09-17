// Model writes merge into the latest state and never replace review/chat data.
export function applyModelUpdate(state = {}, payload = {}) {
  const { configId, model, expectedRevision, auditRecord } = payload;
  if (!configId || (model !== null && model?.configId !== configId)) throw new Error("模型配置标识无效");
  const models = state.capabilities?.models || [];
  const current = models.find((item) => item.configId === configId);
  if ((current ? current.configRevision || "" : null) !== expectedRevision) {
    throw new Error("模型配置已更新或删除，请重试");
  }
  if (model && (!model.configRevision || model.configRevision === expectedRevision)) throw new Error("模型配置版本无效");
  const { apiKey: _apiKey, ...safeModel } = model || {};
  const nextModels = model === null ? models.filter((item) => item.configId !== configId)
    : current ? models.map((item) => item.configId === configId ? safeModel : item) : [safeModel, ...models];
  return {
    ...state,
    capabilities: { ...(state.capabilities || {}), models: nextModels },
    auditRecords: auditRecord ? [auditRecord, ...(state.auditRecords || [])] : state.auditRecords || []
  };
}
