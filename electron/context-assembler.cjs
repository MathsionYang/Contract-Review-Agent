const crypto = require("node:crypto");
const { buildKnowledgeItem, searchKnowledgeSources } = require("./knowledge.cjs");

const DEFAULT_TOKEN_BUDGET = 12000;
const MIN_TOKEN_BUDGET = 320;

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function hashText(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
}

// 中文文本按约 2 个字符一个 Token 估算，并为 JSON 结构保留固定开销。
function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length;
  const nonAscii = text.length - ascii;
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.8 + 6));
}

function normalizeBudget(value) {
  const budget = Number(value || DEFAULT_TOKEN_BUDGET);
  return Math.max(MIN_TOKEN_BUDGET, Math.min(Number.isFinite(budget) ? budget : DEFAULT_TOKEN_BUDGET, 128000));
}

function pageFor(review, pageNumber) {
  const pages = Array.isArray(review?.document?.pages) ? review.document.pages : [];
  return pages.find((page) => Number(page.page) === Number(pageNumber)) || pages[0] || { page: 1, text: "" };
}

function parseClauses(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const clauses = [];
  let current = null;
  let offset = 0;
  for (const line of lines) {
    const normalized = line.trim();
    const match = normalized.match(/^((?:第\s*[一二三四五六七八九十百千万0-9]+\s*条)|(?:\d+(?:\.\d+)+))\s*[、.．：:]?\s*(.*)$/);
    if (match) {
      if (current) clauses.push(current);
      current = {
        clause_no: match[1].replace(/\s+/g, ""),
        title: match[2].trim(),
        text: normalized,
        start: offset,
        end: offset + line.length
      };
    } else if (current) {
      current.text = `${current.text}\n${line}`.trim();
      current.end = offset + line.length;
    }
    offset += line.length + 1;
  }
  if (current) clauses.push(current);
  if (!clauses.length && source.trim()) {
    clauses.push({ clause_no: "当前页", title: "当前页", text: source.trim(), start: 0, end: source.length });
  }
  return clauses;
}

function resolveSelection(review, selectionRef, explicitSelection) {
  if (explicitSelection && typeof explicitSelection === "object") return explicitSelection;
  if (!selectionRef) return null;
  return (review?.annotations || []).find((item) => item.annotation_id === selectionRef) || null;
}

function selectionContext(review, selection, scope = "adjacent_clauses") {
  if (!selection) return null;
  const page = pageFor(review, selection.page);
  const clauses = parseClauses(page.text);
  const quote = String(selection.text_snapshot || selection.text || "").trim();
  let selectedIndex = clauses.findIndex((clause) => clause.clause_no === selection.clause_no);
  if (selectedIndex < 0 && quote) selectedIndex = clauses.findIndex((clause) => clause.text.includes(quote));
  if (selectedIndex < 0) selectedIndex = 0;
  let picked;
  if (scope === "selected_clause") picked = clauses.slice(selectedIndex, selectedIndex + 1);
  else if (scope === "current_chapter") picked = clauses;
  else picked = clauses.slice(Math.max(0, selectedIndex - 1), selectedIndex + 2);
  return {
    annotation_id: String(selection.annotation_id || ""),
    file_version_id: String(selection.file_version_id || review?.project?.file_version_id || ""),
    page: Number(selection.page || page.page || 1),
    clause_no: String(selection.clause_no || picked[0]?.clause_no || ""),
    text: quote,
    text_hash: String(selection.text_hash || hashText(quote)),
    context_scope: scope,
    clauses: picked.map(({ clause_no, title, text }) => ({ clause_no, title, text }))
  };
}

function configuredSources(state, review) {
  const knowledge = state?.knowledge || {};
  const configuredRules = new Set(review?.config?.rules || []);
  const configuredPolicies = new Set(review?.config?.policies || []);
  const rules = (knowledge.rules || [])
    .filter((item) => item.selected !== false && (!configuredRules.size || configuredRules.has(item.file)))
    .map((item) => buildKnowledgeItem({ ...item, kind: "rules", selected: true }));
  const policies = (knowledge.policies || [])
    .filter((item) => item.selected !== false && (!configuredPolicies.size || configuredPolicies.has(item.file)))
    .map((item) => buildKnowledgeItem({ ...item, kind: "policies", selected: true }));
  const snapshot = (knowledge.legalSnapshots || []).find((item) => item.id === review?.config?.snapshot?.id && item.status === "published");
  const legal = snapshot ? [buildKnowledgeItem({
    ...snapshot,
    kind: "legalSnapshots",
    selected: true,
    fileName: snapshot.fileName || snapshot.name,
    fileVersionId: snapshot.fileVersionId || snapshot.file_version_id,
    sourceId: snapshot.id
  })] : [];
  return [...rules, ...policies, ...legal];
}

function buildCitations(state, review, query) {
  const sources = configuredSources(state, review);
  // 长问题会稀释关键词得分，同时用明确出现在问题中的条款标题做一次精确召回。
  const focusedQueries = sources.flatMap((source) => (source.clauses || [])
    .map((clause) => String(clause.title || "").trim())
    .filter((title) => title.length >= 2 && String(query || "").includes(title)));
  const hits = [
    ...searchKnowledgeSources(sources, query, { limit: 10, minScore: 0.05 }),
    ...focusedQueries.flatMap((focused) => searchKnowledgeSources(sources, focused, { limit: 10, minScore: 0.1 }))
  ];
  const uniqueHits = [...new Map(hits.map((hit) => [`${hit.source_id}:${hit.clause_no}`, hit])).values()].slice(0, 10);
  return uniqueHits
    .map((hit, index) => ({
      citation_id: `citation_${hashText(`${hit.source_id}:${hit.clause_no}:${index}`).slice(-16)}`,
      source_type: hit.source_type === "deterministic_rule" ? "rule" : hit.source_type,
      source_id: hit.source_id,
      file_name: hit.file_name,
      file_version_id: hit.file_version_id,
      clause_no: hit.clause_no,
      clause_title: hit.clause_title,
      excerpt: hit.excerpt,
      confidence: Math.min(1, Number(hit.score || 0)),
      verification_status: "verified"
    }));
}

function publicModel(model) {
  return {
    name: String(model?.name || ""),
    model_id: String(model?.modelId || ""),
    config_version: String(model?.version || "cfg-v1"),
    policy: String(model?.policy || "internal_only")
  };
}

function trimString(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactSelection(selection, maxChars) {
  if (!selection) return null;
  const clauses = (selection.clauses || []).map((clause) => ({
    ...clause,
    text: trimString(clause.text, Math.max(80, Math.floor(maxChars / Math.max(selection.clauses.length, 1))))
  }));
  return { ...selection, text: trimString(selection.text, Math.max(80, Math.floor(maxChars / 2))), clauses };
}

function compactSection(name, value, availableTokens) {
  const maxChars = Math.max(80, Math.floor((availableTokens - 10) * 1.8));
  if (name === "user_request") return trimString(value, maxChars);
  if (name === "selection") return compactSelection(value, maxChars);
  if (name === "current_page") return { ...value, text: trimString(value.text, maxChars) };
  if (name === "system") return trimString(value, maxChars);
  return null;
}

function assembleContext(options = {}) {
  const state = options.state || {};
  const review = options.review || {};
  const session = options.session || { messages: [] };
  const preferences = options.contextPreferences || {};
  const tokenBudget = normalizeBudget(options.tokenBudget || options.model?.contextLength || DEFAULT_TOKEN_BUDGET);
  const selection = resolveSelection(review, options.selectionRef, options.selection);
  const selectedScope = preferences.contextScope || options.contextScope || "adjacent_clauses";
  const selectionValue = preferences.includeSelection === false ? null : selectionContext(review, selection, selectedScope);
  const currentPage = pageFor(review, options.currentPage || selection?.page || 1);
  const activeRisk = options.activeRiskId
    ? (review.risks || []).find((risk) => risk.risk_id === options.activeRiskId) || null
    : null;
  const query = [options.userInput, selectionValue?.text, activeRisk?.title, activeRisk?.risk_topic].filter(Boolean).join(" ");
  const citations = preferences.includeKnowledge === false ? [] : buildCitations(state, review, query);
  const memories = preferences.includeMemory === false ? [] : (options.memories || []).map((item) => ({
    memory_id: item.memory_id,
    content: item.content,
    scope: item.scope,
    memory_type: item.memory_type || item.type,
    confidence: Number(item.confidence || 0),
    sensitivity: item.sensitivity || "internal",
    valid_until: item.valid_until || null,
    source_refs: item.source_refs || []
  }));
  const memoryCitations = memories.map((memory) => ({
    citation_id: `citation_memory_${String(memory.memory_id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    source_type: "enterprise_memory",
    source_id: memory.memory_id,
    file_name: "企业记忆",
    file_version_id: memory.memory_id,
    clause_no: memory.scope,
    clause_title: memory.memory_type,
    excerpt: memory.content,
    confidence: memory.confidence,
    verification_status: "verified"
  }));
  const recentMessages = (session.messages || []).filter((item) => ["user", "assistant"].includes(item.role)).slice(-6).map((item) => ({
    message_id: item.message_id,
    role: item.role,
    content: trimString(item.content, 1200)
  }));

  const system = [
    "你是合同审查助手。只能基于给定上下文回答，依据不足时必须说明需要核验。 Return only a JSON object.",
    "只返回 JSON 对象。intent 只能是 answer、create_risk、local_review、clarify。",
    "风险必须保持 conclusion_status=needs_verification、human_status=pending_review，不得自动确认。",
    "引用必须使用上下文中的 citation_id；企业记忆只是内部经验，不得伪装成法律条款。",
    "输出字段：intent、answer、citations、risk_candidates、review_action、memory_candidates、tool_calls、needs_clarification、clarification_question。"
  ].join("\n") + "\nFor every risk_candidates item, contract_location must include an exact quote copied from the contract current_page or selection, plus page and clause_no. Never invent a quote; if no anchor is available, state that verification is required.";
  const metadata = {
    project_id: review.project?.project_id || state.activeProjectId || "",
    project_name: review.project?.project_name || "",
    review_version_id: review.review_version_id || "",
    file_name: review.project?.file_name || review.document?.fileName || "",
    file_version_id: review.project?.file_version_id || "",
    contract_type: review.project?.contract_type || "",
    review_mode: review.project?.review_mode || "",
    execution: {
      legal_snapshot: review.config?.snapshot || null,
      rules: review.config?.rules || [],
      policies: review.config?.policies || [],
      model: publicModel(options.model)
    }
  };
  const sections = [
    { name: "system", value: system, required: true },
    { name: "user_request", value: String(options.userInput || "").trim(), required: true },
    { name: "selection", value: selectionValue, required: Boolean(selectionValue) },
    { name: "active_risk", value: preferences.includeCurrentRisk === false ? null : activeRisk },
    { name: "citations", value: citations },
    { name: "current_page", value: preferences.includeCurrentPage === false ? null : { page: Number(currentPage.page || 1), text: trimString(currentPage.text, 12000), text_hash: hashText(currentPage.text) } },
    { name: "memories", value: memories },
    { name: "memory_citations", value: memoryCitations },
    { name: "recent_messages", value: recentMessages },
    { name: "conversation_summary", value: session.summary || "" }
  ];

  const context = { contract: metadata };
  const includedSections = ["contract"];
  const omittedSections = [];
  let usedTokens = estimateTokens(metadata) + 24;
  for (const section of sections) {
    if (section.value === null || section.value === undefined || section.value === "" || (Array.isArray(section.value) && !section.value.length)) continue;
    let value = section.value;
    let size = estimateTokens(value) + 4;
    if (usedTokens + size > tokenBudget && section.required) {
      value = compactSection(section.name, value, tokenBudget - usedTokens);
      size = value ? estimateTokens(value) + 4 : size;
    }
    if (value && usedTokens + size <= tokenBudget) {
      context[section.name] = value;
      includedSections.push(section.name);
      usedTokens += size;
    } else {
      omittedSections.push(section.name);
    }
  }

  const includedCitations = [...(context.citations || []), ...(context.memory_citations || [])];
  const includedMemories = context.memories || [];
  const snapshot = {
    context_snapshot_id: createId("context_snapshot"),
    project_id: metadata.project_id,
    file_version_id: metadata.file_version_id,
    review_version_id: metadata.review_version_id,
    page_refs: context.current_page ? [{ page: context.current_page.page, text_hash: context.current_page.text_hash }] : [],
    selection_refs: selectionValue ? [{ annotation_id: selectionValue.annotation_id, text_hash: selectionValue.text_hash, page: selectionValue.page, clause_no: selectionValue.clause_no }] : [],
    risk_refs: activeRisk ? [activeRisk.risk_id] : [],
    citation_refs: includedCitations.map((item) => item.citation_id),
    memory_refs: includedMemories.map((item) => item.memory_id),
    session_message_refs: context.recent_messages?.map((item) => item.message_id).filter(Boolean) || [],
    included_sections: includedSections,
    omitted_sections: omittedSections,
    omission_reason: omittedSections.length ? "context_budget" : "",
    token_budget: tokenBudget,
    estimated_tokens: Math.min(usedTokens, tokenBudget),
    model: publicModel(options.model),
    created_at: new Date().toISOString()
  };
  const messages = [
    { role: "system", content: context.system || system },
    { role: "user", content: JSON.stringify({ task: context.user_request || String(options.userInput || ""), context: { ...context, system: undefined, user_request: undefined } }) }
  ];
  return { context, citations: includedCitations, messages, snapshot };
}

module.exports = {
  DEFAULT_TOKEN_BUDGET,
  assembleContext,
  estimateTokens,
  hashText,
  parseClauses,
  selectionContext
};
