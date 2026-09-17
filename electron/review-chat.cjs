const crypto = require("node:crypto");
const { resolveRefs } = require("./contract-evidence.cjs");
const { assembleContext, hashText } = require("./context-assembler.cjs");
const { invokeModel: defaultInvokeModel } = require("./model-gateway.cjs");
const {
  confirmMemoryCandidate,
  createMemoryCandidate,
  dismissMemoryCandidate,
  recallMemories
} = require("./memory-service.cjs");
const { processToolCalls } = require("./tool-protocol.cjs");

const INTENTS = new Set(["answer", "create_risk", "local_review", "clarify"]);
const RISK_LEVELS = new Set(["critical", "high", "medium", "low", "info"]);
const RISK_CATEGORIES = new Set(["legal", "commercial", "company_policy", "text_quality", "evidence"]);

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function errorResult(code, message, extra = {}) {
  return { ok: false, errorCode: code, message, ...extra };
}

function publicModel(model) {
  return {
    configId: model?.configId || null,
    name: String(model?.name || ""),
    model_id: String(model?.modelId || ""),
    config_version: String(model?.version || "cfg-v1"),
    policy: String(model?.policy || "internal_only")
  };
}

function availableAnalysisModels(state = {}) {
  return (state.capabilities?.models || []).filter((model) => (
    model.status === "active"
    && model.role === "analysis"
    && String(model.name || "").trim()
    && String(model.modelId || "").trim()
    && String(model.endpoint || "").trim()
    && model.testStatus === "passed"
  ));
}

function resolveModel(state, review, modelName) {
  const models = availableAnalysisModels(state);
  const preferred = String(modelName || review.config?.execution?.models?.analysis?.configId || review.config?.execution?.models?.analysis?.name || "");
  if (!preferred) return models[0] || null;
  const exact = models.find((model) => model.configId === preferred);
  if (exact) return exact;
  const matches = models.filter((model) => model.name === preferred);
  return matches.length === 1 ? matches[0] : null;
}

function ensureReviewState(state, projectId) {
  const id = String(projectId || state.activeProjectId || "");
  const review = state.reviews?.[id];
  if (!review) return { error: errorResult("REVIEW_NOT_FOUND", "当前项目没有可用的审查版本") };
  review.chat_sessions = Array.isArray(review.chat_sessions) ? review.chat_sessions : [];
  review.risks = Array.isArray(review.risks) ? review.risks : [];
  review.annotations = Array.isArray(review.annotations) ? review.annotations : [];
  review.humanRevisions = Array.isArray(review.humanRevisions) ? review.humanRevisions : [];
  state.knowledge = state.knowledge && typeof state.knowledge === "object" ? state.knowledge : {};
  state.knowledge.memory = Array.isArray(state.knowledge.memory) ? state.knowledge.memory : [];
  state.knowledge.memoryVersions = Array.isArray(state.knowledge.memoryVersions) ? state.knowledge.memoryVersions : [];
  state.auditRecords = Array.isArray(state.auditRecords) ? state.auditRecords : [];
  return { projectId: id, review };
}

function sessionFor(review, options, model) {
  const actorId = String(options.actorId || "local-user");
  let session = options.sessionId
    ? review.chat_sessions.find((item) => item.chat_session_id === options.sessionId)
    : review.chat_sessions.find((item) => item.status === "active" && item.owner_id === actorId);
  if (session && session.owner_id && session.owner_id !== actorId) return { error: errorResult("CHAT_SESSION_FORBIDDEN", "当前用户无权访问该会话") };
  if (!session) {
    const now = new Date().toISOString();
    session = {
      chat_session_id: createId("chat_session"),
      project_id: review.project?.project_id || "",
      review_version_id: review.review_version_id || "",
      status: "active",
      owner_id: actorId,
      selected_model: publicModel(model),
      context_preferences: {
        include_current_page: true,
        include_selection: true,
        include_current_risk: true,
        include_knowledge: true,
        include_memory: true,
        context_scope: "adjacent_clauses"
      },
      summary: "",
      messages: [],
      context_snapshots: [],
      memory_candidates: [],
      execution_records: [],
      requests: [],
      created_at: now,
      updated_at: now
    };
    review.chat_sessions.unshift(session);
  }
  session.messages = Array.isArray(session.messages) ? session.messages : [];
  session.context_snapshots = Array.isArray(session.context_snapshots) ? session.context_snapshots : [];
  session.memory_candidates = Array.isArray(session.memory_candidates) ? session.memory_candidates : [];
  session.execution_records = Array.isArray(session.execution_records) ? session.execution_records : [];
  session.requests = Array.isArray(session.requests) ? session.requests : [];
  session.selected_model = publicModel(model);
  return { session };
}

function preferenceInput(options = {}) {
  const preferences = options.contextPreferences || {};
  return {
    includeCurrentPage: preferences.includeCurrentPage ?? preferences.include_current_page ?? true,
    includeSelection: preferences.includeSelection ?? preferences.include_selection ?? true,
    includeCurrentRisk: preferences.includeCurrentRisk ?? preferences.include_current_risk ?? true,
    includeKnowledge: preferences.includeKnowledge ?? preferences.include_knowledge ?? true,
    includeMemory: preferences.includeMemory ?? preferences.include_memory ?? true,
    contextScope: preferences.contextScope || preferences.context_scope || "adjacent_clauses"
  };
}

function updateSessionPreferences(session, preferences) {
  session.context_preferences = {
    include_current_page: preferences.includeCurrentPage,
    include_selection: preferences.includeSelection,
    include_current_risk: preferences.includeCurrentRisk,
    include_knowledge: preferences.includeKnowledge,
    include_memory: preferences.includeMemory,
    context_scope: preferences.contextScope
  };
}

function auditRecord(action, resource, result, detail, actorId = "local-user") {
  return {
    audit_id: createId("audit"),
    created_at: new Date().toISOString(),
    actor: actorId,
    action,
    resource,
    result,
    detail
  };
}

function findSelection(review, ref) {
  return (review.annotations || []).find((item) => item.annotation_id === ref) || null;
}

function normalizeSelection(selection, review) {
  if (!selection) return null;
  const text = String(selection.text_snapshot || selection.text || "").trim();
  return {
    ...selection,
    text_snapshot: text,
    file_version_id: String(selection.file_version_id || review.project?.file_version_id || ""),
    page: Number(selection.page || 1),
    clause_no: String(selection.clause_no || ""),
    text_hash: String(selection.text_hash || hashText(text))
  };
}

function citationBasis(citation) {
  return {
    source_id: citation.source_id,
    source_level: citation.source_type === "rule" ? "rule" : citation.source_type === "legal_snapshot" ? "l1" : citation.source_type === "enterprise_memory" ? "memory" : "l3",
    file_name: citation.file_name,
    file_version_id: citation.file_version_id,
    clause_no: citation.clause_no,
    clause_title: citation.clause_title,
    title: `${citation.file_name || "依据"} ${citation.clause_no || ""}`.trim(),
    excerpt: citation.excerpt,
    status: citation.verification_status === "verified" ? "published" : "unverified",
    citation_id: citation.citation_id,
    confidence: citation.confidence
  };
}

function normalizeCitations(rawCitations, available) {
  const byId = new Map((available || []).map((item) => [item.citation_id, item]));
  const seen = new Set();
  const result = [];
  for (const raw of rawCitations || []) {
    const id = typeof raw === "string" ? raw : raw?.citation_id;
    if (!id || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    result.push(byId.get(id));
  }
  return result;
}

function contractPages(review) {
  const pages = Array.isArray(review?.document?.pages) && review.document.pages.length
    ? review.document.pages
    : [{ page: 1, text: String(review?.document?.text || "") }];
  return pages.map((item) => ({ page: Number(item.page) || 1, text: String(item.text || "") }));
}

function normalizedText(value) {
  return String(value || "").replace(/[\s\u3000]+/g, " ").trim();
}

function clauseBefore(text, index) {
  const prefix = String(text || "").slice(0, Math.max(0, index));
  const matches = prefix.match(/(?:第\s*[一二三四五六七八九十百千万\d]+\s*条|(?:clause|section)\s*\d+(?:\.\d+)*)/gi);
  return matches?.at(-1)?.replace(/\s+/g, "") || "";
}

function originalRange(rawText, normalizedQuote) {
  const text = String(rawText || "");
  const quote = String(normalizedQuote || "");
  const directIndex = text.indexOf(quote);
  if (directIndex >= 0) return { quote, index: directIndex };
  const parts = quote.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(escaped.join("\\s+"), "i").exec(text);
  return match ? { quote: match[0], index: match.index } : null;
}

function exactAnchor(pages, candidate, preferredPage) {
  const needle = normalizedText(candidate);
  if (needle.length < 8) return null;
  const ordered = [...pages].sort((left, right) => (Number(left.page) === Number(preferredPage) ? -1 : 0) - (Number(right.page) === Number(preferredPage) ? -1 : 0));
  for (const page of ordered) {
    const located = originalRange(page.text, needle);
    if (located) return { page: page.page, quote: located.quote, char_range: [located.index, located.index + located.quote.length], clause_no: clauseBefore(page.text, located.index), confidence: 1 };
  }
  return null;
}

function anchorCandidates(value) {
  const source = normalizedText(value);
  if (source.length < 8) return [];
  const segments = source
    .split(/[。！？.!?;；\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
  const candidates = [source.slice(0, 180), source.slice(-180), ...segments];
  for (const segment of segments) {
    if (segment.length <= 16) continue;
    for (const windowLength of [120, 80, 48, 32, 24, 16]) {
      if (segment.length <= windowLength) continue;
      for (let start = 0; start < segment.length; start += 12) {
        candidates.push(segment.slice(start, start + windowLength));
      }
    }
    const words = segment.split(/\s+/).filter(Boolean);
    for (let start = 1; start < words.length - 1; start += 1) {
      candidates.push(words.slice(start).join(" "));
    }
  }
  return [...new Set(candidates.map((item) => item.trim()).filter((item) => item.length >= 8))]
    .sort((left, right) => right.length - left.length);
}

function inferredAnchor(pages, candidates, preferredPage) {
  let best = null;
  for (const candidate of candidates) {
    const fragments = anchorCandidates(candidate);
    if (!fragments.length) continue;
    for (const page of pages) {
      const pageText = normalizedText(page.text);
      const comparablePageText = pageText.toLocaleLowerCase();
      for (const fragment of fragments) {
        const pageIndex = comparablePageText.indexOf(fragment.toLocaleLowerCase());
        if (pageIndex < 0) continue;
        const pageQuote = pageText.slice(pageIndex, pageIndex + fragment.length);
        const located = originalRange(page.text, pageQuote);
        const originalQuote = located?.quote || pageQuote;
        const originalIndex = located?.index ?? pageIndex;
        const score = fragment.length + (Number(page.page) === Number(preferredPage) ? 3 : 0);
        if (!best || score > best.score) {
          best = { page: page.page, quote: originalQuote, char_range: [originalIndex, originalIndex + originalQuote.length], clause_no: clauseBefore(page.text, originalIndex), confidence: 0.9, score };
        }
        break;
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...anchor } = best;
  return anchor;
}

function resolveContractAnchor(review, raw, requested, selection, fallbackRisk, preferredPage, userInput) {
  const pages = contractPages(review);
  const requestedQuote = requested.quote || raw?.quote || selection?.text_snapshot || fallbackRisk?.contract_location?.quote || "";
  const direct = exactAnchor(pages, requestedQuote, preferredPage);
  if (direct) return direct;
  if (requestedQuote) return null;
  const candidates = [
    requested.contract_text,
    requested.clause_text,
    requested.evidence,
    raw?.contract_text,
    raw?.clause_text,
    raw?.evidence,
    raw?.analysis,
    raw?.suggestion,
    raw?.recommendation,
    userInput,
    raw?.title
  ].filter(Boolean);
  return inferredAnchor(pages, candidates, preferredPage);
}

function normalizeRisk(raw, options = {}) {
  const review = options.review || {};
  const selection = options.selection || null;
  const fallbackRisk = options.activeRisk || null;
  const requested = raw?.contract_location || raw?.contractLocation || {};
  const page = Number(requested.page || selection?.page || fallbackRisk?.contract_location?.page || options.currentPage || 1);
  let anchor = resolveContractAnchor(review, raw, requested, selection, fallbackRisk, page, options.userInput);
  if (anchor && review.document?.blocks?.length) {
    const refs = resolveRefs(review.document, anchor.quote);
    const matches = refs.filter((ref) => (ref.logical_page ?? ref.page) === anchor.page);
    anchor = matches.length === 1 ? { ...anchor, ...matches[0], source_refs: [matches[0]] } : null;
  }
  const quote = String(anchor?.quote || "");
  const locationVerified = Boolean(quote);
  const citations = options.citations || [];
  const evidenceCitations = citations.filter((item) => item.source_type !== "enterprise_memory");
  const evidenceVerified = evidenceCitations.length > 0 && evidenceCitations.every((item) => item.verification_status === "verified");
  const bases = citations.map(citationBasis);
  return {
    risk_id: String(raw?.risk_id || createId("chat_risk")),
    source_type: String(options.sourceType || "chat_model"),
    evidence_origin: "chat_model",
    chat_ref: options.messageId,
    review_type: raw?.review_type || options.reviewType || undefined,
    risk_level: RISK_LEVELS.has(raw?.risk_level) ? raw.risk_level : "medium",
    risk_category: RISK_CATEGORIES.has(raw?.risk_category) ? raw.risk_category : "evidence",
    risk_topic: String(raw?.risk_topic || raw?.topic || options.topic || "general"),
    title: String(raw?.title || "对话审查发现待核验风险"),
    conclusion_status: "needs_verification",
    evidence_status: evidenceVerified && locationVerified ? "verified" : "unverified",
    human_status: "pending_review",
    location_confidence: locationVerified ? Number(anchor?.confidence || 1) : 0,
    contract_location: {
      file_version_id: review.project?.file_version_id || "",
      page: anchor?.page ?? null,
      clause_no: String(anchor?.clause_no || ""),
      quote,
      location_status: locationVerified ? "resolved" : "unresolved",
      ...(anchor?.char_range ? { char_range: anchor.char_range } : {}),
      ...(anchor?.source_refs ? { block_id: anchor.block_id, logical_page: anchor.logical_page, range_scope: anchor.range_scope, source_refs: anchor.source_refs } : {}),
      ...(anchor?.text_hash ? { text_hash: anchor.text_hash } : locationVerified && selection?.text_hash ? { text_hash: selection.text_hash } : {})
    },
    analysis: String(raw?.analysis || "该结果由对话审查生成，需结合原文和依据完成人工核验。"),
    suggestion: String(raw?.recommendation || raw?.suggestion || "请完成人工复核后再确认风险结论。"),
    legal_basis: bases.filter((item) => item.source_level === "l1"),
    company_basis: bases.filter((item) => item.source_level !== "l1")
  };
}

function normalizeResponse(data, assembled, options = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return errorResult("MODEL_OUTPUT_INVALID", "模型返回内容不是有效的对话审核对象");
  if (!INTENTS.has(data.intent)) return errorResult("MODEL_OUTPUT_INVALID", "模型返回了不支持的对话意图");
  const intent = data.intent;
  const citations = normalizeCitations(data.citations, assembled.citations);
  const answer = String(data.answer || data.content || "").trim();
  if (!answer && intent !== "clarify") return errorResult("MODEL_OUTPUT_INVALID", "模型返回结果缺少 answer 字段");
  const riskCandidates = Array.isArray(data.risk_candidates) ? data.risk_candidates.filter((item) => item && typeof item === "object") : [];
  if (intent === "create_risk" && !riskCandidates.length) return errorResult("MODEL_OUTPUT_INVALID", "模型声明创建风险但没有返回风险候选");
  if (intent === "local_review" && data.review_action?.type !== "local_review") return errorResult("MODEL_OUTPUT_INVALID", "局部审查结果缺少有效的 review_action");
  return {
    ok: true,
    value: {
      response_id: createId("chat_response"),
      intent,
      answer: answer || String(data.clarification_question || "请补充审查范围。"),
      citations,
      risk_candidates: riskCandidates,
      review_action: data.review_action && typeof data.review_action === "object" ? data.review_action : null,
      memory_candidates: Array.isArray(data.memory_candidates) ? data.memory_candidates.filter((item) => item && typeof item === "object") : [],
      tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls.filter((item) => item && typeof item === "object") : [],
      needs_clarification: intent === "clarify" || Boolean(data.needs_clarification),
      clarification_question: String(data.clarification_question || "")
    }
  };
}

function summarizeSession(session) {
  if ((session.messages || []).length < 12) return;
  const relevant = session.messages.filter((message) => ["user", "assistant"].includes(message.role)).slice(-12);
  const lines = relevant.map((message) => `${message.role === "user" ? "用户" : "助手"}：${String(message.content || "").replace(/\s+/g, " ").slice(0, 180)}`);
  session.summary = lines.join("\n").slice(0, 2200);
  session.summary_checkpoint = {
    message_count: session.messages.length,
    last_message_id: session.messages.at(-1)?.message_id || "",
    created_at: new Date().toISOString(),
    strategy: "deterministic_recent_messages"
  };
}

function decodePartialJsonString(value) {
  const safe = String(value || "").replace(/\\$/g, "");
  try { return JSON.parse(`"${safe}"`); } catch (_error) {
    return safe.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

// 结构化 JSON 采用 SSE 返回时，只把 answer 字段的增量发送到界面，避免展示 JSON 碎片。
function createAnswerDeltaEmitter(sendEvent, requestId, sessionId) {
  let buffer = "";
  let emitted = "";
  return (rawDelta) => {
    const raw = String(rawDelta || "");
    buffer += raw;
    const match = buffer.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (match) {
      const answer = decodePartialJsonString(match[1]);
      const delta = answer.startsWith(emitted) ? answer.slice(emitted.length) : answer;
      emitted = answer;
      if (delta) sendEvent({ type: "delta", requestId, sessionId, delta });
      return;
    }
    if (!buffer.trimStart().startsWith("{") && !/[{}]/.test(buffer)) {
      emitted += raw;
      sendEvent({ type: "delta", requestId, sessionId, delta: raw });
    }
  };
}

function addRiskRevision(review, riskRefs, messageId) {
  if (!riskRefs.length) return;
  const baseVersion = review.review_version_id;
  const nextVersion = `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-CHAT-${Date.now().toString(36)}`;
  review.humanRevisions.unshift({
    review_version_id: nextVersion,
    source_type: "chat_model_candidate",
    base_review_version_id: baseVersion,
    risk_refs: riskRefs,
    chat_message_id: messageId,
    created_by: "对话审查",
    created_at: new Date().toISOString(),
    reason: "对话审查生成待核验风险",
    changes: { risk_refs: riskRefs, conclusion_status: "needs_verification" }
  });
  review.review_version_id = nextVersion;
  review.task = { ...(review.task || {}), status: "waiting_confirmation", progress: Math.min(Number(review.task?.progress || 100), 86) };
}

function createReviewChatService(options = {}) {
  if (!options.storage || typeof options.storage.loadState !== "function" || typeof options.storage.saveState !== "function") {
    throw new Error("对话服务需要本地状态存储");
  }
  const storage = options.storage;
  const invokeModel = options.invokeModel || defaultInvokeModel;
  const sendEvent = typeof options.sendEvent === "function" ? options.sendEvent : () => {};
  const activeRequests = new Map();

  async function execute(optionsInput = {}) {
    const input = clone(optionsInput) || {};
    const userInput = String(input.userInput || "").trim();
    if (!userInput) return errorResult("CHAT_INPUT_REQUIRED", "请输入需要审查的问题");
    if (userInput.length > 10000) return errorResult("CHAT_INPUT_TOO_LONG", "单次输入不能超过 10000 个字符");
    const state = storage.loadState();
    const checked = ensureReviewState(state, input.projectId);
    if (checked.error) return checked.error;
    const { projectId, review } = checked;
    const model = resolveModel(state, review, input.modelName);
    if (!model) return errorResult("MODEL_NOT_AVAILABLE", "未配置已启用且通过本地校验的 analysis 模型");
    const sessionResult = sessionFor(review, input, model);
    if (sessionResult.error) return sessionResult.error;
    const session = sessionResult.session;
    const preferences = preferenceInput(input);
    updateSessionPreferences(session, preferences);
    const actorId = String(input.actorId || "local-user");
    const requestId = String(input.requestId || createId("chat_request"));
    const userMessage = {
      message_id: createId("chat_message"),
      session_id: session.chat_session_id,
      role: "user",
      content: userInput,
      status: "completed",
      created_at: new Date().toISOString()
    };
    const recalled = recallMemories({
      memories: state.knowledge.memory,
      query: userInput,
      context: { contractType: review.project?.contract_type, projectId, actorId },
      model,
      policy: state.settings?.chatPermissions || {}
    });
    const assembled = assembleContext({
      state,
      review,
      session,
      userInput,
      currentPage: input.currentPage,
      selectionRef: input.selectionRef,
      selection: input.selection,
      activeRiskId: input.activeRiskId,
      contextPreferences: preferences,
      memories: recalled,
      tokenBudget: Math.max(320, Number(input.tokenBudget || model.contextLength || 12000) - Number(model.maxTokens || 2048)),
      model
    });
    userMessage.context_snapshot_id = assembled.snapshot.context_snapshot_id;
    userMessage.model = publicModel(model);
    session.messages.push(userMessage);
    session.context_snapshots.push(assembled.snapshot);
    session.requests.push({
      request_id: requestId,
      user_message_id: userMessage.message_id,
      context_snapshot_id: assembled.snapshot.context_snapshot_id,
      model: publicModel(model),
      status: "running",
      retry_count: Number(input.retryCount || 0),
      created_at: new Date().toISOString()
    });
    session.updated_at = new Date().toISOString();
    storage.saveState(state);

    const controller = new AbortController();
    activeRequests.set(requestId, { controller, projectId, sessionId: session.chat_session_id });
    sendEvent({ type: "start", requestId, sessionId: session.chat_session_id });
    const emitAnswerDelta = createAnswerDeltaEmitter(sendEvent, requestId, session.chat_session_id);
    let modelResult;
    try {
      modelResult = await invokeModel({
        model,
        messages: assembled.messages,
        responseSchema: { type: "object" },
        signal: controller.signal,
        stream: true,
        contextSnapshot: assembled.snapshot,
        onDelta: emitAnswerDelta
      });
    } catch (error) {
      modelResult = errorResult(error.code || "MODEL_REQUEST_FAILED", error.message || "模型调用失败");
    } finally {
      activeRequests.delete(requestId);
    }
    if (controller.signal.aborted) modelResult = errorResult("MODEL_REQUEST_CANCELLED", "模型请求已取消");

    const latestState = storage.loadState();
    const latestChecked = ensureReviewState(latestState, projectId);
    if (latestChecked.error) return latestChecked.error;
    const latestReview = latestChecked.review;
    const latestSession = latestReview.chat_sessions.find((item) => item.chat_session_id === session.chat_session_id);
    const request = latestSession.requests.find((item) => item.request_id === requestId);
    if (!modelResult?.ok) {
      const cancelled = controller.signal.aborted || modelResult?.errorCode === "MODEL_REQUEST_CANCELLED";
      const errorCode = cancelled ? "MODEL_REQUEST_CANCELLED" : (modelResult?.errorCode || "MODEL_REQUEST_FAILED");
      const assistant = {
        message_id: createId("chat_message"),
        session_id: latestSession.chat_session_id,
        role: "assistant",
        content: cancelled ? "本次对话审核已停止。" : (modelResult?.message || "模型调用失败，可使用相同上下文重试。"),
        intent: "answer",
        status: cancelled ? "cancelled" : "failed",
        error_code: errorCode,
        context_snapshot_id: assembled.snapshot.context_snapshot_id,
        model_call_ref: requestId,
        retryable: true,
        created_at: new Date().toISOString()
      };
      latestSession.messages.push(assistant);
      Object.assign(request, { status: assistant.status, completed_at: new Date().toISOString(), error_code: errorCode });
      latestSession.updated_at = new Date().toISOString();
      summarizeSession(latestSession);
      latestState.auditRecords.unshift(auditRecord("对话审核", requestId, errorCode, assistant.content, actorId));
      storage.saveState(latestState);
      sendEvent({ type: assistant.status, requestId, sessionId: latestSession.chat_session_id, errorCode });
      return errorResult(errorCode, assistant.content, { requestId, sessionId: latestSession.chat_session_id, state: latestState, message: assistant });
    }

    const normalized = normalizeResponse(modelResult.data, assembled, input);
    if (!normalized.ok) {
      const assistant = {
        message_id: createId("chat_message"),
        session_id: latestSession.chat_session_id,
        role: "assistant",
        content: normalized.message,
        intent: "answer",
        status: "failed",
        error_code: normalized.errorCode,
        context_snapshot_id: assembled.snapshot.context_snapshot_id,
        model_call_ref: requestId,
        retryable: true,
        created_at: new Date().toISOString()
      };
      latestSession.messages.push(assistant);
      Object.assign(request, { status: "failed", completed_at: new Date().toISOString(), error_code: normalized.errorCode });
      latestState.auditRecords.unshift(auditRecord("对话审核", requestId, normalized.errorCode, normalized.message, actorId));
      storage.saveState(latestState);
      sendEvent({ type: "failed", requestId, sessionId: latestSession.chat_session_id, errorCode: normalized.errorCode });
      return { ...normalized, requestId, sessionId: latestSession.chat_session_id, state: latestState, message: assistant };
    }

    const response = normalized.value;
    const assistantMessageId = createId("chat_message");
    const selectionRef = response.review_action?.selection_ref || input.selectionRef;
    // 已保存标记优先；用户刚划出的临时选区也允许直接触发局部审查。
    const selection = normalizeSelection(findSelection(latestReview, selectionRef) || input.selection, latestReview);
    if (response.intent === "local_review" && !selection) {
      response.intent = "clarify";
      response.answer = "请先在合同原文中选择需要局部审查的文字，再重新发送请求。";
      response.review_action = null;
      response.needs_clarification = true;
      response.clarification_question = "是否先选择需要审查的合同条款？";
    }
    const activeRisk = input.activeRiskId ? latestReview.risks.find((item) => item.risk_id === input.activeRiskId) : null;
    const risks = [];
    if (response.intent === "create_risk") {
      for (const candidate of response.risk_candidates) {
        risks.push(normalizeRisk(candidate, {
          review: latestReview,
          selection,
          activeRisk,
          currentPage: input.currentPage,
          userInput,
          citations: response.citations,
          messageId: assistantMessageId
        }));
      }
    }
    if (response.intent === "local_review" && response.review_action?.type === "local_review" && selection) {
      risks.push(normalizeRisk({
        title: `对话局部审查：${response.review_action.topic || "通用条款"}需进一步核验`,
        risk_level: "medium",
        risk_category: "legal",
        risk_topic: response.review_action.topic || "general",
        analysis: response.answer,
        recommendation: "请结合选区上下文和引用依据完成人工复核。",
        review_type: response.review_action.review_type,
        contract_location: {
          page: selection.page,
          clause_no: selection.clause_no,
          quote: selection.text_snapshot
        }
      }, {
        review: latestReview,
        selection,
        currentPage: input.currentPage,
        userInput,
        citations: response.citations,
        messageId: assistantMessageId,
        sourceType: "chat_local_review",
        reviewType: response.review_action.review_type,
        topic: response.review_action.topic
      }));
    }
    if (risks.length) latestReview.risks = [...risks, ...latestReview.risks];

    const memoryCandidates = response.memory_candidates.map((candidate) => createMemoryCandidate({
      ...candidate,
      source_refs: [...new Set([...(candidate.source_refs || []), assistantMessageId, ...response.citations.map((item) => item.citation_id)])]
    }));
    latestSession.memory_candidates.unshift(...memoryCandidates);
    memoryCandidates.forEach((candidate) => latestState.auditRecords.unshift(auditRecord(
      "MEMORY_CANDIDATE_CREATED",
      candidate.candidate_id,
      "待确认",
      `${candidate.scope} · ${candidate.memory_type}`,
      actorId
    )));

    const executionRecords = await processToolCalls(response.tool_calls, {
      enabledSkills: latestReview.config?.execution?.skills?.map((skill) => skill.name) || [],
      enabledMcpTools: latestState.capabilities?.mcpTools?.filter((tool) => tool.status === "enabled").map((tool) => tool.name) || [],
      permissionPolicy: latestState.settings?.chatPermissions || {},
      executor: options.toolExecutor || null
    });
    latestSession.execution_records.push(...executionRecords);

    const riskRefs = risks.map((risk) => risk.risk_id);
    const memoryRefs = memoryCandidates.map((candidate) => candidate.candidate_id);
    const assistant = {
      message_id: assistantMessageId,
      session_id: latestSession.chat_session_id,
      role: "assistant",
      content: response.answer,
      intent: response.intent,
      status: "completed",
      citations: response.citations,
      context_snapshot_id: assembled.snapshot.context_snapshot_id,
      model_call_ref: requestId,
      model: publicModel(model),
      risk_refs: riskRefs,
      memory_candidate_refs: memoryRefs,
      execution_refs: executionRecords.map((item) => item.execution_id),
      review_action: response.review_action,
      needs_clarification: response.needs_clarification,
      clarification_question: response.clarification_question,
      created_at: new Date().toISOString()
    };
    latestSession.messages.push(assistant);
    addRiskRevision(latestReview, riskRefs, assistantMessageId);
    latestSession.updated_at = new Date().toISOString();
    latestSession.review_version_id = latestReview.review_version_id;
    summarizeSession(latestSession);
    Object.assign(request, {
      status: "completed",
      assistant_message_id: assistantMessageId,
      completed_at: new Date().toISOString(),
      latency_ms: Number(modelResult.latencyMs || 0),
      usage: modelResult.usage || null,
      intent: response.intent
    });
    latestState.auditRecords.unshift(auditRecord(
      "对话审核",
      requestId,
      "成功",
      `${response.intent} · ${riskRefs.length} 条风险 · ${memoryRefs.length} 条记忆候选`,
      actorId
    ));
    storage.saveState(latestState);
    sendEvent({ type: "complete", requestId, sessionId: latestSession.chat_session_id, messageId: assistantMessageId });
    return {
      ok: true,
      requestId,
      sessionId: latestSession.chat_session_id,
      message: assistant,
      response: {
        ...response,
        risk_refs: riskRefs,
        memory_candidate_refs: memoryRefs,
        execution_refs: executionRecords.map((item) => item.execution_id)
      },
      state: latestState
    };
  }

  async function retry(input = {}) {
    const state = storage.loadState();
    const checked = ensureReviewState(state, input.projectId);
    if (checked.error) return checked.error;
    const session = checked.review.chat_sessions.find((item) => item.chat_session_id === input.sessionId);
    if (!session) return errorResult("CHAT_SESSION_NOT_FOUND", "找不到需要重试的会话");
    const target = input.messageId
      ? session.messages.find((item) => item.message_id === input.messageId)
      : [...session.messages].reverse().find((item) => item.role === "assistant" && item.retryable);
    if (!target) return errorResult("CHAT_RETRY_TARGET_NOT_FOUND", "找不到可重试的失败消息");
    const targetIndex = session.messages.indexOf(target);
    const userMessage = [...session.messages.slice(0, targetIndex)].reverse().find((item) => item.role === "user");
    if (!userMessage) return errorResult("CHAT_RETRY_TARGET_NOT_FOUND", "失败消息缺少对应的用户输入");
    return execute({
      ...input,
      userInput: userMessage.content,
      sessionId: session.chat_session_id,
      modelName: input.modelName || target.model?.name || session.selected_model?.name,
      retryCount: Number(input.retryCount || 0) + 1
    });
  }

  function cancel(input = {}) {
    const requestId = String(input.requestId || "");
    const active = activeRequests.get(requestId);
    if (!active) return errorResult("CHAT_REQUEST_NOT_ACTIVE", "当前请求已经结束或不存在");
    active.controller.abort();
    return { ok: true, requestId, status: "cancelling" };
  }

  function confirmMemory(input = {}) {
    const state = storage.loadState();
    const checked = ensureReviewState(state, input.projectId);
    if (checked.error) return checked.error;
    if (state.settings?.chatPermissions?.memoryWrite === "deny") {
      return errorResult("MEMORY_WRITE_DENIED", "系统设置已禁止写入企业记忆");
    }
    const session = checked.review.chat_sessions.find((item) => item.chat_session_id === input.sessionId);
    if (!session) return errorResult("CHAT_SESSION_NOT_FOUND", "企业记忆候选所属会话不存在");
    if (session.owner_id && session.owner_id !== String(input.actorId || "local-user")) return errorResult("CHAT_SESSION_FORBIDDEN", "当前用户无权修改该会话的记忆候选");
    const index = session.memory_candidates.findIndex((item) => item.candidate_id === input.candidateId);
    if (index < 0) return errorResult("MEMORY_CANDIDATE_NOT_FOUND", "企业记忆候选不存在");
    const result = confirmMemoryCandidate({
      candidate: session.memory_candidates[index],
      edited: input.edited,
      resolution: input.resolution,
      memories: state.knowledge.memory,
      actorId: input.actorId || "local-user"
    });
    session.memory_candidates[index] = result.candidate || session.memory_candidates[index];
    if (!result.ok) {
      session.memory_candidates[index].conflicts = result.conflicts || [];
      session.memory_candidates[index].sensitivity_findings = result.findings || session.memory_candidates[index].sensitivity_findings || [];
      storage.saveState(state);
      return { ...result, state };
    }
    state.knowledge.memory = result.memories;
    if (result.versionRecord) state.knowledge.memoryVersions.unshift(result.versionRecord);
    state.auditRecords.unshift(result.auditRecord);
    storage.saveState(state);
    return { ...result, state };
  }

  function dismissMemory(input = {}) {
    const state = storage.loadState();
    const checked = ensureReviewState(state, input.projectId);
    if (checked.error) return checked.error;
    const session = checked.review.chat_sessions.find((item) => item.chat_session_id === input.sessionId);
    if (!session) return errorResult("CHAT_SESSION_NOT_FOUND", "企业记忆候选所属会话不存在");
    if (session.owner_id && session.owner_id !== String(input.actorId || "local-user")) return errorResult("CHAT_SESSION_FORBIDDEN", "当前用户无权修改该会话的记忆候选");
    const index = session.memory_candidates.findIndex((item) => item.candidate_id === input.candidateId);
    if (index < 0) return errorResult("MEMORY_CANDIDATE_NOT_FOUND", "企业记忆候选不存在");
    const result = dismissMemoryCandidate(session.memory_candidates[index], input.reason, input.actorId || "local-user");
    session.memory_candidates[index] = result.candidate;
    state.auditRecords.unshift(result.auditRecord);
    storage.saveState(state);
    return { ...result, state };
  }

  return {
    chat: execute,
    retry,
    cancel,
    confirmMemory,
    dismissMemory,
    activeRequestCount: () => activeRequests.size
  };
}

module.exports = {
  availableAnalysisModels,
  createReviewChatService,
  normalizeResponse,
  normalizeRisk,
  summarizeSession
};
