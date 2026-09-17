function executionModel(state, review, role) {
  const snapshotModel = review?.config?.execution?.models?.[role];
  const candidates = (state?.capabilities?.models || []).filter((item) => item.role === role && item.status === "active"
    && (item.testStatus === "passed" || item.testStatus === undefined));
  if (!snapshotModel) return candidates[0] || null;
  const matches = candidates.filter((item) => snapshotModel.configId ? item.configId === snapshotModel.configId : item.name === snapshotModel.name);
  return matches.length === 1 ? matches[0] : null;
}

function modelIdentity(model) {
  return model ? { config_id: model.configId || null, model_name: model.name, model_id: model.modelId || model.name, version: model.version || "" } : { model_name: null };
}

module.exports = { executionModel, modelIdentity };
