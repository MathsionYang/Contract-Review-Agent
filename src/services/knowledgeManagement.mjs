export const knowledgeLabels = { legalSnapshots: "法律快照", rules: "确定性规则", policies: "企业制度", memory: "企业记忆", audit: "审计记录" };

export function knowledgeItemKey(kind, item) {
  const reference = kind === "legalSnapshots" ? item.id : kind === "memory" ? item.content : kind === "audit" ? item.audit_id : item.file;
  return JSON.stringify([kind, item.entry_id || (kind === "memory" && item.memory_id) || reference]);
}

export function knowledgeItems(state, kind) {
  return (kind === "audit" ? state?.auditRecords : state?.knowledge?.[kind]) || [];
}

export function reconcileDeletedKnowledge(state, saved = {}) {
  const deletions = [...new Map([...(state.deletedKnowledge || []), ...(saved?.deletedKnowledge || [])].map((entry) => [entry.key, entry])).values()];
  if (!deletions.length) return state;
  const keys = new Set(deletions.map((entry) => entry.key));
  const knowledge = { ...(state.knowledge || {}) };
  for (const kind of Object.keys(knowledgeLabels).filter((kind) => kind !== "audit")) {
    knowledge[kind] = knowledgeItems(state, kind).filter((item) => !keys.has(knowledgeItemKey(kind, item)));
  }
  const auditRecords = knowledgeItems(state, "audit").filter((item) => !keys.has(knowledgeItemKey("audit", item)));
  const auditIds = new Set(auditRecords.map((item) => item.audit_id));
  for (const item of saved?.auditRecords || []) {
    if (item.event_type === "knowledge_deleted" && !auditIds.has(item.audit_id) && !keys.has(knowledgeItemKey("audit", item))) auditRecords.unshift(item);
  }
  // 清理当前配置中的失效引用，历史风险原文、依据和人工处理记录保持不变。
  const reviews = Object.fromEntries(Object.entries(state.reviews || {}).map(([id, review]) => {
    if (!review.config) return [id, review];
    const config = { ...review.config };
    for (const kind of ["rules", "policies"]) {
      const removed = new Set(deletions.filter((entry) => entry.kind === kind && !knowledge[kind].some((item) => item.file === entry.reference)).map((entry) => entry.reference));
      if (Array.isArray(config[kind])) config[kind] = config[kind].filter((file) => !removed.has(file));
    }
    if (deletions.some((entry) => entry.kind === "legalSnapshots" && entry.reference === config.snapshot?.id)
      && !knowledge.legalSnapshots.some((item) => item.id === config.snapshot?.id)) config.snapshot = { id: "", status: "draft" };
    return [id, { ...review, config }];
  }));
  return { ...state, knowledge, reviews, auditRecords, deletedKnowledge: deletions };
}

export function deleteKnowledgeEntries(state, kind, targetKeys) {
  if (!Object.hasOwn(knowledgeLabels, kind)) throw new Error("知识库类型无效");
  if (!Array.isArray(targetKeys) || !targetKeys.length) throw new Error("请选择要删除的记录");
  const keys = new Set(targetKeys);
  const targets = knowledgeItems(state, kind).filter((item) => keys.has(knowledgeItemKey(kind, item)));
  if (!targets.length) throw new Error("记录不存在或已被删除");
  const createdAt = new Date().toISOString();
  const deletions = targets.map((item) => ({
    key: knowledgeItemKey(kind, item), kind, deleted_at: createdAt,
    reference: kind === "legalSnapshots" ? item.id : kind === "memory" ? item.content : kind === "audit" ? item.audit_id : item.file,
    // 知识条目保留证据归档，审计记录删除只保留标识，不复制被删除的日志内容。
    ...(kind !== "audit" ? { archived_item: item } : {})
  }));
  return reconcileDeletedKnowledge({
    ...state,
    deletedKnowledge: [...(state.deletedKnowledge || []), ...deletions],
    auditRecords: [{
      audit_id: `audit_knowledge_delete_${globalThis.crypto.randomUUID()}`,
      created_at: createdAt, actor: "本地法务用户", event_type: "knowledge_deleted",
      action: `删除${knowledgeLabels[kind]}`, resource: kind, result: "成功",
      detail: `已删除 ${targets.length} 条记录；保留合同历史证据和磁盘文件。`
    }, ...(state.auditRecords || [])]
  });
}
