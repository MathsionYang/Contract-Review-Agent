const crypto = require("node:crypto");

const CONFIRMED_STATUSES = new Set(["正式", "已确认", "confirmed", "formal", "published", "active"]);
const REVOKED_STATUSES = new Set(["已撤销", "revoked", "expired", "dismissed"]);

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeMemory(raw = {}, index = 0) {
  return {
    ...raw,
    memory_id: String(raw.memory_id || raw.id || `memory_${crypto.createHash("sha1").update(`${raw.content || ""}:${index}`).digest("hex").slice(0, 12)}`),
    content: String(raw.content || "").trim(),
    scope: String(raw.scope || "organization"),
    memory_type: String(raw.memory_type || raw.type || "review_practice"),
    status: String(raw.status || raw.canonical_status || "candidate"),
    canonical_status: String(raw.canonical_status || (CONFIRMED_STATUSES.has(String(raw.status)) ? "confirmed" : "candidate")),
    confidence: Math.min(1, Math.max(0, Number(raw.confidence ?? 0.5))),
    sensitivity: String(raw.sensitivity || "internal"),
    valid_from: raw.valid_from || null,
    valid_until: raw.valid_until || null,
    source_refs: Array.isArray(raw.source_refs) ? raw.source_refs : [],
    conflict_keys: Array.isArray(raw.conflict_keys) ? raw.conflict_keys.filter(Boolean).map(String) : []
  };
}

function statusAllowed(memory) {
  return CONFIRMED_STATUSES.has(String(memory.status)) || memory.canonical_status === "confirmed";
}

function validAt(memory, now) {
  const current = new Date(now || Date.now()).getTime();
  const from = memory.valid_from ? new Date(memory.valid_from).getTime() : null;
  const until = memory.valid_until ? new Date(memory.valid_until).getTime() : null;
  if (Number.isFinite(from) && current < from) return false;
  if (Number.isFinite(until) && current > until) return false;
  return true;
}

function scopeAllowed(scope, context = {}) {
  const value = String(scope || "organization").trim();
  if (["organization", "organization:*", "org", "组织级", "全组织"].includes(value)) return true;
  if (value.startsWith("project:")) return value.slice(8) === String(context.projectId || "");
  if (value.startsWith("contract_type:")) return value.slice(14) === String(context.contractType || "");
  if (value.startsWith("user:")) return value.slice(5) === String(context.actorId || "local-user");
  return false;
}

function sensitivityAllowed(memory, model = {}, policy = {}) {
  const sensitivity = String(memory.sensitivity || "internal");
  const modelPolicy = String(model.policy || "internal_only");
  if (sensitivity === "public") return true;
  if (modelPolicy === "local_only" || modelPolicy === "internal_only") return sensitivity !== "restricted" || policy.allowRestrictedLocalMemory === true;
  return policy.allowExternalModelSensitiveData === true && sensitivity !== "restricted";
}

function grams(value) {
  const normalized = String(value || "").toLowerCase().replace(/[\s，。；、：:,.!?！？()（）\[\]{}]+/g, "");
  const result = new Set();
  const ascii = normalized.match(/[a-z0-9_%.-]{2,}/g) || [];
  ascii.forEach((item) => result.add(item));
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

function relevance(content, query) {
  const queryGrams = grams(query);
  if (!queryGrams.size) return 0;
  const contentGrams = grams(content);
  let matched = 0;
  queryGrams.forEach((item) => { if (contentGrams.has(item)) matched += 1; });
  return matched / queryGrams.size;
}

function recallMemories(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 6), 20));
  return (options.memories || [])
    .map(normalizeMemory)
    .filter((memory) => memory.content && statusAllowed(memory))
    .filter((memory) => !REVOKED_STATUSES.has(memory.status) && validAt(memory, options.now))
    .filter((memory) => scopeAllowed(memory.scope, options.context))
    .filter((memory) => sensitivityAllowed(memory, options.model, options.policy))
    .map((memory) => ({ ...memory, relevance: relevance(memory.content, options.query) }))
    .filter((memory) => memory.relevance > 0)
    .sort((left, right) => {
      const scopeBoost = (item) => String(item.scope).startsWith("contract_type:") ? 0.06 : String(item.scope).startsWith("project:") ? 0.08 : 0;
      const leftScore = left.relevance * 0.62 + left.confidence * 0.32 + scopeBoost(left);
      const rightScore = right.relevance * 0.62 + right.confidence * 0.32 + scopeBoost(right);
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

function scanSensitiveContent(value) {
  const text = String(value || "");
  const findings = [];
  const checks = [
    ["CREDENTIAL", /(?:sk-[a-z0-9_-]{6,}|api[ _-]?key\s*[:=]|bearer\s+[a-z0-9._-]+)/i, "疑似凭据或认证信息"],
    ["PHONE", /(?<!\d)1[3-9]\d{9}(?!\d)/, "疑似手机号码"],
    ["EMAIL", /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "疑似电子邮箱"],
    ["IDENTITY", /(?<!\d)\d{17}[0-9Xx](?!\d)/, "疑似身份证号码"],
    ["BANK_ACCOUNT", /(?<!\d)\d{16,19}(?!\d)/, "疑似银行卡号"],
    ["CONTRACT_AMOUNT", /(?:人民币|金额|价款|合同价)[^。；\n]{0,16}\d[\d,.]*\s*(?:元|万元|亿元)/, "疑似当前合同具体金额"],
    ["UNVERIFIED_CONCLUSION", /(?:未经核验|未核验|needs_verification).{0,24}(?:结论|认定|确定)/i, "疑似未核验结论"]
  ];
  for (const [code, pattern, message] of checks) {
    if (pattern.test(text)) findings.push({ code, message, severity: "blocking" });
  }
  return findings;
}

function createMemoryCandidate(input = {}) {
  const content = String(input.content || "").trim();
  if (!content) throw new Error("记忆候选内容不能为空");
  const sensitivityFindings = scanSensitiveContent(content);
  return {
    candidate_id: String(input.candidate_id || input.candidateId || id("memory_candidate")),
    content,
    scope: String(input.scope || "organization"),
    memory_type: String(input.memory_type || input.type || "review_practice"),
    confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.7))),
    sensitivity: String(input.sensitivity || "internal"),
    valid_from: input.valid_from || new Date().toISOString().slice(0, 10),
    valid_until: input.valid_until || null,
    source_refs: Array.isArray(input.source_refs) ? input.source_refs.filter(Boolean).map(String) : [],
    conflict_keys: Array.isArray(input.conflict_keys) ? input.conflict_keys.filter(Boolean).map(String) : [],
    status: "candidate",
    sensitivity_findings: sensitivityFindings,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: input.updated_at || new Date().toISOString()
  };
}

function findMemoryConflicts(candidate, memories = []) {
  const keys = new Set(candidate.conflict_keys || []);
  if (!keys.size) return [];
  return memories
    .map(normalizeMemory)
    .filter((memory) => statusAllowed(memory) && !REVOKED_STATUSES.has(memory.status))
    .filter((memory) => memory.conflict_keys.some((key) => keys.has(key)))
    .filter((memory) => memory.content !== candidate.content);
}

function audit(action, resource, detail, actorId) {
  return {
    audit_id: id("audit"),
    created_at: new Date().toISOString(),
    actor: actorId || "local-user",
    action,
    resource,
    result: "成功",
    detail
  };
}

function confirmMemoryCandidate(options = {}) {
  const base = createMemoryCandidate({ ...(options.candidate || {}), ...(options.edited || {}), candidate_id: options.candidate?.candidate_id });
  if (options.candidate?.status && options.candidate.status !== "candidate") {
    return { ok: false, errorCode: "MEMORY_CANDIDATE_NOT_PENDING", message: "记忆候选已经处理", candidate: base };
  }
  const sensitivityFindings = scanSensitiveContent(base.content);
  if (sensitivityFindings.length) {
    return { ok: false, errorCode: "MEMORY_SENSITIVE_DATA", message: "记忆候选包含需要脱敏或抽象的信息", findings: sensitivityFindings, candidate: { ...base, sensitivity_findings: sensitivityFindings } };
  }
  const memories = clone(options.memories || []);
  const conflicts = findMemoryConflicts(base, memories);
  if (conflicts.length && !["replace", "merge", "keep_existing"].includes(options.resolution)) {
    return { ok: false, errorCode: "MEMORY_CONFLICT", message: "记忆候选与现有正式记忆冲突", conflicts, candidate: base };
  }
  if (options.resolution === "keep_existing") {
    return {
      ok: true,
      keptExisting: true,
      candidate: { ...base, status: "dismissed", resolution: "keep_existing", updated_at: new Date().toISOString() },
      memories,
      auditRecord: audit("MEMORY_DISMISSED", base.candidate_id, "存在冲突，保留原有记忆", options.actorId)
    };
  }
  if (options.resolution === "replace") {
    const conflictIds = new Set(conflicts.map((item) => item.memory_id));
    memories.forEach((memory, index) => {
      const normalized = normalizeMemory(memory, index);
      if (conflictIds.has(normalized.memory_id)) {
        memory.status = "已撤销";
        memory.canonical_status = "revoked";
        memory.revoked_at = new Date().toISOString();
        memory.replaced_by_candidate_id = base.candidate_id;
      }
    });
  }
  let content = base.content;
  let sourceRefs = [...base.source_refs];
  if (options.resolution === "merge" && conflicts.length) {
    content = [...conflicts.map((item) => item.content), base.content].filter(Boolean).join("；");
    sourceRefs = [...new Set([...conflicts.flatMap((item) => item.source_refs || []), ...sourceRefs])];
  }
  const memory = {
    memory_id: id("memory"),
    memory_version_id: id("memory_version"),
    content,
    scope: base.scope,
    type: base.memory_type,
    memory_type: base.memory_type,
    status: "正式",
    canonical_status: "confirmed",
    confidence: String(base.confidence),
    sensitivity: base.sensitivity,
    valid_from: base.valid_from,
    valid_until: base.valid_until,
    source_refs: sourceRefs,
    conflict_keys: base.conflict_keys,
    confirmed_by: options.actorId || "local-user",
    confirmed_at: new Date().toISOString(),
    candidate_id: base.candidate_id
  };
  memories.unshift(memory);
  return {
    ok: true,
    memory,
    memories,
    conflicts,
    candidate: { ...base, status: "confirmed", memory_id: memory.memory_id, resolution: options.resolution || "none", updated_at: new Date().toISOString() },
    auditRecord: audit("MEMORY_CONFIRMED", memory.memory_id, `${base.scope} · ${base.memory_type} · ${options.resolution || "no_conflict"}`, options.actorId),
    versionRecord: {
      memory_version_id: memory.memory_version_id,
      memory_id: memory.memory_id,
      candidate_id: base.candidate_id,
      action: "confirmed",
      created_at: memory.confirmed_at,
      actor_id: options.actorId || "local-user"
    }
  };
}

function dismissMemoryCandidate(candidate = {}, reason = "", actorId = "local-user") {
  if (!candidate.candidate_id) throw new Error("记忆候选不存在");
  const next = { ...candidate, status: "dismissed", dismiss_reason: String(reason || "用户放弃"), updated_at: new Date().toISOString() };
  return {
    ok: true,
    candidate: next,
    auditRecord: audit("MEMORY_DISMISSED", candidate.candidate_id, next.dismiss_reason, actorId)
  };
}

module.exports = {
  confirmMemoryCandidate,
  createMemoryCandidate,
  dismissMemoryCandidate,
  findMemoryConflicts,
  normalizeMemory,
  recallMemories,
  scanSensitiveContent,
  scopeAllowed,
  sensitivityAllowed
};
