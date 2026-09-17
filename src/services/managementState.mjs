// 这些纯函数集中处理治理配置，方便界面和测试共享同一套状态规则。
export function createKnowledgeItem(type, input = {}) {
  const file = String(input.file || "").trim();
  if (!file) throw new Error("文件名不能为空");

  const base = {
    file,
    summary: String(input.summary || "").trim() || "待补充文件摘要",
    selected: Boolean(input.selected)
  };

  if (type === "rules") {
    return {
      ...base,
      status: input.status || "active",
      type: String(input.type || "自定义规则"),
      priority: input.priority || "high"
    };
  }

  return {
    ...base,
    status: input.status || "published",
    version: String(input.version || "v1.0")
  };
}

export function removeKnowledgeItems(items = [], files = []) {
  const targets = new Set(files.filter(Boolean));
  return items.filter((item) => !targets.has(item.file));
}

export function upsertModel(models = [], model = {}) {
  if (!model.configId) return [{ ...model, configId: crypto.randomUUID() }, ...models];
  if (!models.some((item) => item.configId === model.configId)) throw new Error("待编辑的模型配置不存在，请刷新列表");
  return models.map((item) => item.configId === model.configId ? { ...item, ...model } : item);
}

export function ensureModelIds(models = []) {
  const seen = new Set();
  return models.map((model) => {
    const configId = model.configId && !seen.has(model.configId) ? model.configId : crypto.randomUUID();
    seen.add(configId);
    return { ...model, configId, ...(model.testStatus === "testing" ? { testStatus: "untested", testMessage: "上次连接测试未完成" } : {}) };
  });
}

export function findModel(models = [], reference) {
  const exact = models.find((model) => model.configId && model.configId === reference);
  if (exact) return exact;
  const named = models.filter((model) => model.name === reference);
  return named.length === 1 ? named[0] : null;
}

// 清理早期版本写入的演示模型，保留用户后来手工保存的其他模型配置。
export function removeDemoModels(models = []) {
  const demoSignatures = new Set([
    "hunyuan-pro|hunyuan-pro|http://model-gateway.local/v1",
    "extract-fast|extract-fast|http://model-gateway.local/v1",
    "bge-m3|BAAI/bge-m3|http://127.0.0.1:8080/embeddings",
    "fallback-glm4|glm-4|https://api.example.com/v1"
  ]);
  return models.filter((model) => {
    const signature = `${model?.name || ""}|${model?.modelId || ""}|${String(model?.endpoint || "").replace(/\/$/, "")}`;
    return model?.source !== "demo" && !demoSignatures.has(signature);
  });
}

export function removeModel(models = [], reference) {
  const target = findModel(models, reference);
  return models.filter((model) => model !== target);
}

export function mergeSettings(current = {}, patch = {}) {
  return { ...current, ...patch };
}

export function legalSnapshotStatusLabel(status) {
  return { published: "已发布", draft: "草稿 · 待发布", historical: "历史归档", superseded: "已被替代", revoked: "已撤销" }[status] || "状态未知";
}

// 法律快照属于版本化引用，编辑时允许修改展示和治理字段，但不能替换快照内容及身份。
export function updateLegalSnapshot(snapshots = [], snapshotId, patch = {}) {
  const id = String(snapshotId || "").trim();
  const index = snapshots.findIndex((snapshot) => snapshot.id === id);
  if (!id || index < 0) throw new Error("法律快照不存在");

  const current = snapshots[index];
  const next = { ...current, status: patch.status ?? current.status, source_url: String(patch.source_url ?? current.source_url ?? "").trim() };
  next.name = String(patch.name ?? current.name ?? "").trim();
  next.coverage = String(patch.coverage ?? current.coverage ?? "").trim();
  next.publishedAt = String(patch.publishedAt ?? current.publishedAt ?? "").trim();
  next.sources = Number(patch.sources ?? current.sources ?? 0);
  if (!next.name) throw new Error("法律快照名称不能为空");
  if (!next.coverage) throw new Error("法律快照覆盖范围不能为空");
  if (!Number.isInteger(next.sources) || next.sources < 0) throw new Error("来源数必须是非负整数");
  if (!["published", "draft", "historical", "superseded", "revoked"].includes(next.status)) throw new Error("法律快照状态无效");
  if (next.status === "published") {
    if (/^(待填写|未填写|待补充)$/.test(next.coverage)) throw new Error("发布前请填写实际覆盖范围，例如：设备采购、交付、质量检验、价款支付");
    if (current.parse_status === "failed" || current.parseStatus === "failed" || !current.clauses?.length
      || current.clauses.some((clause) => !String(clause?.text || clause?.excerpt || "").trim())) throw new Error("快照缺少可引用的条款正文，请重新导入后发布");
    if (current.status !== "published") next.publishedAt = new Date().toISOString();
  }

  return [...snapshots.slice(0, index), next, ...snapshots.slice(index + 1)];
}

// 企业记忆使用内容作为列表键，修改内容时返回新数组，避免影响调用方持有的旧状态。
export function updateEnterpriseMemory(memory = [], originalContent, patch = {}) {
  const original = String(originalContent || "").trim();
  const index = memory.findIndex((item) => item.content === original);
  if (!original || index < 0) throw new Error("企业记忆不存在");

  const current = memory[index];
  const next = { ...current, ...patch };
  next.content = String(patch.content ?? current.content ?? "").trim();
  next.scope = String(patch.scope ?? current.scope ?? "").trim();
  next.type = String(patch.type ?? current.type ?? "").trim();
  next.status = String(patch.status ?? current.status ?? "").trim();
  next.confidence = String(patch.confidence ?? current.confidence ?? "").trim();
  if (!next.content) throw new Error("企业记忆内容不能为空");
  if (!next.scope || !next.type) throw new Error("企业记忆作用域和类型不能为空");
  if (!["正式", "候选", "已撤销"].includes(next.status)) throw new Error("企业记忆状态无效");
  const confidence = Number(next.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("置信度必须在 0 到 1 之间");

  return [...memory.slice(0, index), next, ...memory.slice(index + 1)];
}

// 使用稳定的非加密哈希标记选区文本，便于在同一文件版本内回溯而不保存原文之外的敏感信息。
export function hashSelectionText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createSelectionAnnotation(input = {}) {
  const text = String(input.text || input.text_snapshot || "").trim();
  if (!text) throw new Error("选区内容不能为空");
  const fileVersionId = String(input.fileVersionId || input.file_version_id || "").trim();
  if (!fileVersionId) throw new Error("选区缺少文件版本");
  const page = Number(input.page);
  if (!Number.isInteger(page) || page < 1) throw new Error("选区页码无效");

  const charRange = Array.isArray(input.charRange)
    ? input.charRange
    : Array.isArray(input.char_range) ? input.char_range : null;
  const coordinateRange = Array.isArray(input.coordinateRange)
    ? input.coordinateRange
    : Array.isArray(input.coordinate_range) ? input.coordinate_range : null;

  return {
    annotation_id: String(input.annotationId || input.annotation_id || `selection_${Date.now()}`),
    source_type: "manual_selection",
    text_snapshot: text,
    text_hash: String(input.textHash || input.text_hash || hashSelectionText(text)),
    file_version_id: fileVersionId,
    page,
    clause_no: String(input.clauseNo || input.clause_no || ""),
    ...(charRange ? { char_range: charRange } : {}),
    ...(coordinateRange ? { coordinate_range: coordinateRange } : {}),
    created_at: input.createdAt || input.created_at || new Date().toISOString()
  };
}

export function createManualReviewRisk(input = {}) {
  const selection = createSelectionAnnotation(input.selection || {});
  const reviewType = String(input.reviewType || input.review_type || "legal_risk");
  const topic = String(input.topic || "general");
  const reviewLabels = {
    legal_risk: "法律风险",
    reasonableness: "条款合理性",
    template_compare: "模板对比",
    suggestion: "修改建议",
    explanation: "条款解释",
    special: "专项审核"
  };
  const topicLabels = {
    payment: "付款",
    breach: "违约责任",
    liability: "责任限制",
    ip: "知识产权",
    confidentiality: "保密",
    data: "数据保护",
    termination: "解除终止",
    dispute: "争议解决",
    general: "通用条款"
  };
  const label = reviewLabels[reviewType] || reviewType;
  const topicLabel = topicLabels[topic] || topic;

  return {
    risk_id: String(input.riskId || input.risk_id || `manual_${Date.now()}`),
    source_type: "manual_selection_review",
    review_type: reviewType,
    risk_level: input.riskLevel || "medium",
    risk_category: input.riskCategory || "legal",
    risk_topic: topic,
    title: String(input.title || `${label}：${topicLabel}需进一步核验`),
    conclusion_status: "needs_verification",
    evidence_status: "unverified",
    human_status: "pending_review",
    location_confidence: Number.isFinite(Number(input.locationConfidence)) ? Number(input.locationConfidence) : 1,
    contract_location: {
      file_version_id: selection.file_version_id,
      page: selection.page,
      clause_no: selection.clause_no,
      ...(selection.char_range ? { char_range: selection.char_range } : {}),
      ...(selection.coordinate_range ? { coordinate_range: selection.coordinate_range } : {}),
      quote: selection.text_snapshot,
      text_hash: selection.text_hash
    },
    analysis: String(input.analysis || "这是基于人工选区生成的局部审查候选，当前证据不足以直接形成确认结论。"),
    suggestion: String(input.suggestion || "建议查看所在条款和关联上下文，补充制度、模板或法律依据后再确认。"),
    context_scope: input.contextScope || "选区所在条款及相邻同级条款",
    selection_annotation_id: selection.annotation_id
  };
}

// 将能力配置压缩成一次审查可追溯的执行快照，避免把 API 地址和凭据带入审查结果。
export function buildReviewExecutionConfig(capabilities = {}, previous = {}, updatedAt = new Date().toISOString()) {
  const roles = ["analysis", "extraction", "embedding", "rerank", "vision"];
  const skills = (capabilities.skills || [])
    .filter((skill) => skill.status === "enabled")
    .map((skill) => ({
      name: skill.name,
      version: skill.version,
      scope: skill.scope
    }));
  // New configurations must pass a connection test before selection; keep legacy configs compatible.
  const activeModels = (capabilities.models || []).filter((model) => (
    model.status === "active" && (model.testStatus === "passed" || model.testStatus === undefined)
  ));
  const models = Object.fromEntries(roles.map((role) => {
    const previousRef = previous.models?.[role]?.configId || previous.models?.[role]?.name;
    const selected = findModel(activeModels.filter((model) => model.role === role), previousRef)
      || activeModels.find((model) => model.role === role);
    return [role, selected ? {
      ...(selected.configId ? { configId: selected.configId } : {}),
      name: selected.name,
      modelId: selected.modelId || selected.name,
      provider: selected.provider || "",
      version: selected.version || "",
      policy: selected.policy || ""
    } : null];
  }));

  return {
    skills,
    models,
    selectionMode: "active",
    updatedAt
  };
}
