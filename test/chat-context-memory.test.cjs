const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStorage } = require("../electron/storage.cjs");
const { invokeModel } = require("../electron/model-gateway.cjs");

let contextAssembler = {};
let memoryService = {};
let reviewChat = {};
let toolProtocol = {};
try { contextAssembler = require("../electron/context-assembler.cjs"); } catch (_error) {}
try { memoryService = require("../electron/memory-service.cjs"); } catch (_error) {}
try { reviewChat = require("../electron/review-chat.cjs"); } catch (_error) {}
try { toolProtocol = require("../electron/tool-protocol.cjs"); } catch (_error) {}

function baseReview() {
  return {
    review_version_id: "RV-CHAT-01",
    project: {
      project_id: "project-chat",
      project_name: "软件采购合同",
      file_version_id: "contract_v1",
      contract_type: "procurement",
      review_mode: "standard"
    },
    document: {
      fileName: "软件采购合同.docx",
      pageCount: 2,
      text: "1.1 定义\n系统指本项目软件。\n1.2 付款\n预付款为合同金额的 40%。\n1.3 验收\n验收通过后支付尾款。\n2.1 违约\n逾期交付应承担违约责任。",
      pages: [
        { page: 1, text: "1.1 定义\n系统指本项目软件。\n1.2 付款\n预付款为合同金额的 40%。\n1.3 验收\n验收通过后支付尾款。" },
        { page: 2, text: "2.1 违约\n逾期交付应承担违约责任。" }
      ]
    },
    risks: [],
    annotations: [{
      annotation_id: "selection-1",
      source_type: "manual_selection",
      text_snapshot: "预付款为合同金额的 40%。",
      text_hash: "fnv1a-test",
      file_version_id: "contract_v1",
      page: 1,
      clause_no: "1.2",
      char_range: [24, 40]
    }],
    humanRevisions: [],
    exportRecords: [],
    config: {
      snapshot: { id: "CN-CHAT", status: "published" },
      rules: ["采购规则.md"],
      policies: ["采购制度.docx"],
      execution: {
        models: { analysis: { name: "analysis-main", modelId: "deepseek-chat", version: "cfg-v1", policy: "internal_only" } },
        skills: [{ name: "selected-text-review", version: "1.0.0", scope: "全部合同" }]
      }
    },
    task: { task_id: "task-chat", status: "completed", progress: 100 }
  };
}

function baseState() {
  const review = baseReview();
  return {
    activeProjectId: "project-chat",
    projects: [review.project],
    reviews: { "project-chat": review },
    knowledge: {
      rules: [{
        file: "采购规则.md",
        file_version_id: "rule-v1",
        selected: true,
        status: "active",
        clauses: [{ clause_no: "R-01", title: "预付款比例", text: "预付款不得超过合同金额的 30%。" }]
      }],
      policies: [{
        file: "采购制度.docx",
        file_version_id: "policy-v1",
        version: "v3.2",
        selected: true,
        status: "published",
        clauses: [{ clause_no: "4.2", title: "预付款", text: "预付款比例超过 30% 时应取得专项审批。" }]
      }],
      legalSnapshots: [{
        id: "CN-CHAT",
        name: "中华人民共和国民法典快照",
        fileVersionId: "legal-v1",
        status: "published",
        clauses: [{ clause_no: "第五百零九条", title: "全面履行", text: "当事人应当按照约定全面履行自己的义务。" }]
      }],
      memory: [{
        memory_id: "memory-public",
        content: "采购合同预付款超过 30% 时通常需要专项审批。",
        scope: "contract_type:procurement",
        type: "review_practice",
        status: "正式",
        confidence: "0.92",
        sensitivity: "public",
        valid_from: "2026-01-01"
      }]
    },
    capabilities: {
      models: [{
        name: "analysis-main",
        modelId: "deepseek-chat",
        provider: "本地测试网关",
        endpoint: "https://model.example/v1",
        role: "analysis",
        version: "cfg-v1",
        policy: "internal_only",
        contextLength: 16000,
        maxTokens: 2048,
        timeoutMs: 30000,
        retries: 0,
        credentialRef: "none",
        status: "active",
        testStatus: "passed"
      }],
      skills: [{ name: "selected-text-review", version: "1.0.0", scope: "全部合同", status: "enabled", permissions: ["read_contract_context"] }]
    },
    settings: {
      chatPermissions: {
        sessionAccess: "local_user",
        memoryWrite: "confirm_only",
        toolExecution: "confirm",
        allowExternalModelSensitiveData: false
      }
    },
    auditRecords: []
  };
}

test("对话调用向量检索并将候选依据和执行记录写入上下文，关闭知识时不调用", async () => {
  const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "chat-embedding-")));
  const state = baseState();
  state.capabilities.models.push({ ...state.capabilities.models[0], name: "embedding-main", role: "embedding", modelId: "vector" });
  storage.saveState(state);
  const calls = [];
  let payload;
  const service = reviewChat.createReviewChatService({ storage, invokeModel: async (request) => {
    calls.push(request.model.role);
    if (request.model.role === "embedding") return { ok: true, data: { vectors: request.input.map(() => [1, 0]) } };
    payload = JSON.parse(request.messages[1].content);
    return { ok: true, data: { intent: "answer", answer: "需核验", citations: [] } };
  } });
  const result = await service.chat({ projectId: "project-chat", userInput: "迟延交货如何追偿？" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["embedding", "embedding", "analysis"]);
  assert.ok(payload.context.citations.some((citation) => citation.retrieval_method === "hybrid" && citation.verification_status === "candidate"));
  assert.equal(result.message.retrieval.status, "completed");
  const snapshot = storage.loadState().reviews["project-chat"].chat_sessions[0].context_snapshots[0];
  assert.equal(snapshot.retrieval.call_count, 2);
  calls.length = 0;
  const noKnowledge = await service.chat({ projectId: "project-chat", userInput: "仅看合同原文", contextPreferences: { includeKnowledge: false } });
  assert.equal(noKnowledge.ok, true);
  assert.deepEqual(calls, ["analysis"]);
});

test("向量检索阶段可取消对话，不再启动分析或写入成功结果", async () => {
  const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "chat-embedding-cancel-")));
  const state = baseState();
  state.capabilities.models.push({ ...state.capabilities.models[0], name: "embedding-main", role: "embedding" });
  storage.saveState(state);
  let called;
  const entered = new Promise((resolve) => { called = resolve; });
  const service = reviewChat.createReviewChatService({ storage, invokeModel: async ({ model, signal }) => {
    assert.equal(model.role, "embedding");
    called();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, errorCode: "MODEL_REQUEST_CANCELLED" }), { once: true }));
  } });
  const pending = service.chat({ projectId: "project-chat", requestId: "embedding-cancel", userInput: "检查合同" });
  await entered;
  assert.equal(service.activeRequestCount(), 1);
  service.cancel({ requestId: "embedding-cancel" });
  const result = await pending;
  assert.equal(result.errorCode, "MODEL_REQUEST_CANCELLED");
  assert.equal(service.activeRequestCount(), 0);
});

test("上下文组装按选区扩圈并生成不含凭据的预算快照", () => {
  assert.equal(typeof contextAssembler.assembleContext, "function");
  const state = baseState();
  const result = contextAssembler.assembleContext({
    state,
    review: state.reviews["project-chat"],
    session: { chat_session_id: "session-1", summary: "用户关注付款风险", messages: [] },
    userInput: "审查选中的预付款条款并给出依据",
    currentPage: 1,
    selectionRef: "selection-1",
    memories: state.knowledge.memory,
    tokenBudget: 1800,
    model: state.capabilities.models[0]
  });

  assert.equal(result.snapshot.file_version_id, "contract_v1");
  assert.equal(result.snapshot.selection_refs[0].annotation_id, "selection-1");
  assert.ok(result.context.selection.clauses.some((clause) => clause.clause_no === "1.1"));
  assert.ok(result.context.selection.clauses.some((clause) => clause.clause_no === "1.2"));
  assert.ok(result.context.selection.clauses.some((clause) => clause.clause_no === "1.3"));
  assert.ok(result.citations.some((citation) => citation.file_name === "采购制度.docx" && citation.clause_no === "4.2"));
  assert.ok(result.snapshot.estimated_tokens <= result.snapshot.token_budget);
  assert.equal(JSON.stringify(result).includes("credentialRef"), false);
});

test("上下文超预算时保留本轮指令与选区并记录被省略范围", () => {
  assert.equal(typeof contextAssembler.assembleContext, "function");
  const state = baseState();
  const session = {
    chat_session_id: "session-budget",
    summary: "旧会话摘要".repeat(100),
    messages: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `历史消息 ${index} ${"很长".repeat(80)}` }))
  };
  const result = contextAssembler.assembleContext({
    state,
    review: state.reviews["project-chat"],
    session,
    userInput: "只审查当前选区",
    currentPage: 1,
    selectionRef: "selection-1",
    memories: state.knowledge.memory,
    tokenBudget: 520,
    model: state.capabilities.models[0]
  });

  assert.ok(result.snapshot.included_sections.includes("user_request"));
  assert.ok(result.snapshot.included_sections.includes("selection"));
  assert.ok(result.snapshot.omitted_sections.length > 0);
  assert.equal(result.snapshot.omission_reason, "context_budget");
  assert.ok(result.snapshot.estimated_tokens <= 520);
});

test("企业记忆召回过滤过期、候选、越权和外部模型敏感内容", () => {
  assert.equal(typeof memoryService.recallMemories, "function");
  const memories = [
    { memory_id: "ok", content: "采购合同预付款超过 30% 需要审批", status: "正式", scope: "contract_type:procurement", confidence: 0.9, sensitivity: "public" },
    { memory_id: "internal", content: "采购付款联系人为张三", status: "正式", scope: "contract_type:procurement", confidence: 0.9, sensitivity: "internal" },
    { memory_id: "candidate", content: "采购合同不需要验收", status: "候选", scope: "contract_type:procurement", confidence: 0.9, sensitivity: "public" },
    { memory_id: "expired", content: "采购预付款旧规则", status: "正式", scope: "contract_type:procurement", confidence: 0.9, sensitivity: "public", valid_until: "2025-01-01" },
    { memory_id: "other", content: "销售合同付款规则", status: "正式", scope: "contract_type:sales", confidence: 0.9, sensitivity: "public" }
  ];

  const result = memoryService.recallMemories({
    memories,
    query: "采购预付款审批",
    context: { contractType: "procurement", projectId: "project-chat", actorId: "local-user" },
    model: { policy: "approved_external" },
    policy: { allowExternalModelSensitiveData: false },
    now: "2026-09-11T00:00:00.000Z"
  });

  assert.deepEqual(result.map((item) => item.memory_id), ["ok"]);
});

test("记忆候选在敏感扫描和冲突处理完成前不能写入正式记忆", () => {
  assert.equal(typeof memoryService.createMemoryCandidate, "function");
  assert.equal(typeof memoryService.confirmMemoryCandidate, "function");

  const unsafe = memoryService.createMemoryCandidate({
    content: "本合同联系人 13800138000，API Key=sk-secret",
    scope: "contract_type:procurement",
    source_refs: ["chat_message_1"]
  });
  const blocked = memoryService.confirmMemoryCandidate({ candidate: unsafe, memories: [] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCode, "MEMORY_SENSITIVE_DATA");

  const existing = [{ memory_id: "old", content: "预付款上限为 20%", status: "正式", scope: "contract_type:procurement", conflict_keys: ["payment.prepayment.limit"] }];
  const candidate = memoryService.createMemoryCandidate({
    content: "采购合同预付款上限按 30% 执行",
    scope: "contract_type:procurement",
    conflict_keys: ["payment.prepayment.limit"],
    source_refs: ["chat_message_2"]
  });
  const unresolved = memoryService.confirmMemoryCandidate({ candidate, memories: existing });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.errorCode, "MEMORY_CONFLICT");
  assert.equal(unresolved.conflicts[0].memory_id, "old");

  const confirmed = memoryService.confirmMemoryCandidate({ candidate, memories: existing, resolution: "replace", actorId: "local-user" });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.memory.status, "正式");
  assert.equal(confirmed.memory.canonical_status, "confirmed");
  assert.equal(confirmed.memories.find((item) => item.memory_id === "old").status, "已撤销");
  assert.equal(confirmed.auditRecord.action, "MEMORY_CONFIRMED");
});

test("统一工具协议对没有真实执行器的 MCP 和 Skill 只记录阻断结果", async () => {
  assert.equal(typeof toolProtocol.processToolCalls, "function");
  const records = await toolProtocol.processToolCalls([
    { kind: "mcp", name: "legal.search", arguments: { query: "民法典" } },
    { kind: "skill", name: "selected-text-review", arguments: { topic: "payment" } }
  ], {
    enabledSkills: ["selected-text-review"],
    permissionPolicy: { toolExecution: "allow" },
    executor: null
  });

  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.status === "blocked"));
  assert.ok(records.every((record) => record.sandbox?.required === true));
  assert.ok(records.every((record) => record.error_code === "TOOL_EXECUTOR_UNAVAILABLE"));
});

test("模型网关支持 SSE 增量回调并区分用户取消", async () => {
  const deltas = [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"intent":"answer",' } }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '"answer":"完成"}' } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  const streamed = await invokeModel({
    model: { endpoint: "https://model.example/v1", modelId: "analysis-model", credentialRef: "none" },
    messages: [],
    stream: true,
    onDelta: (delta) => deltas.push(delta),
    fetchImpl: async () => ({ ok: true, status: 200, body: stream })
  });
  assert.equal(streamed.ok, true);
  assert.deepEqual(streamed.data, { intent: "answer", answer: "完成" });
  assert.equal(deltas.join(""), '{"intent":"answer","answer":"完成"}');

  const abort = new AbortController();
  abort.abort();
  const cancelled = await invokeModel({
    model: { endpoint: "https://model.example/v1", modelId: "analysis-model", credentialRef: "none" },
    messages: [],
    signal: abort.signal,
    fetchImpl: async (_url, options) => {
      options.signal.throwIfAborted();
      return { ok: false, status: 499 };
    }
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.errorCode, "MODEL_REQUEST_CANCELLED");
});

test("对话结果会持久化会话、上下文快照、待核验风险和记忆候选", async () => {
  assert.equal(typeof reviewChat.createReviewChatService, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-chat-"));
  const storage = createStorage(root);
  storage.saveState(baseState());
  const events = [];
  const service = reviewChat.createReviewChatService({
    storage,
    sendEvent: (event) => events.push(event),
    invokeModel: async (options) => {
      options.onDelta?.('{"intent":"create_risk","answer":"正在核验付款');
      options.onDelta?.('条款"}');
      return {
        ok: true,
        latencyMs: 18,
        usage: { total_tokens: 120 },
        data: {
          intent: "create_risk",
          answer: "预付款比例高于制度阈值，已生成待核验风险。",
          citations: [{ citation_id: options.contextSnapshot.citation_refs[0] }],
          risk_candidates: [{
            title: "预付款比例超过制度阈值",
            risk_level: "high",
            risk_category: "company_policy",
            risk_topic: "payment",
            analysis: "预付款比例为 40%，高于 30% 的制度阈值。",
            recommendation: "降低预付款比例或补充专项审批。",
            contract_location: { page: 1, clause_no: "1.2", quote: "预付款为合同金额的 40%。" }
          }],
          memory_candidates: [{
            content: "采购合同预付款超过 30% 时通常需要专项审批。",
            scope: "contract_type:procurement",
            memory_type: "review_practice",
            confidence: 0.9,
            sensitivity: "internal",
            conflict_keys: ["payment.prepayment.approval"]
          }]
        }
      };
    }
  });

  const result = await service.chat({
    projectId: "project-chat",
    userInput: "审查选中的预付款条款并生成风险",
    modelName: "analysis-main",
    currentPage: 1,
    selectionRef: "selection-1",
    contextPreferences: { includeSelection: true, includeCurrentPage: true, includeMemory: true }
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.intent, "create_risk");
  assert.equal(result.response.risk_refs.length, 1);
  assert.equal(result.response.memory_candidate_refs.length, 1);
  assert.ok(events.some((event) => event.type === "delta"));
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.delta).join(""), "正在核验付款条款");

  const saved = storage.loadState();
  const review = saved.reviews["project-chat"];
  assert.equal(review.chat_sessions.length, 1);
  assert.equal(review.chat_sessions[0].messages.length, 2);
  assert.equal(review.chat_sessions[0].context_snapshots.length, 1);
  assert.equal(review.risks[0].source_type, "chat_model");
  assert.equal(review.risks[0].conclusion_status, "needs_verification");
  assert.equal(review.risks[0].human_status, "pending_review");
  assert.equal(review.chat_sessions[0].memory_candidates[0].status, "candidate");
});

test("对话触发局部审查时复用选区锚点且自动摘要长会话", async () => {
  assert.equal(typeof reviewChat.createReviewChatService, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-local-chat-"));
  const storage = createStorage(root);
  const state = baseState();
  state.reviews["project-chat"].chat_sessions = [{
    chat_session_id: "chat_session_existing",
    project_id: "project-chat",
    review_version_id: "RV-CHAT-01",
    status: "active",
    owner_id: "local-user",
    messages: Array.from({ length: 12 }, (_, index) => ({ message_id: `old-${index}`, role: index % 2 ? "assistant" : "user", content: `历史审查消息 ${index}` })),
    context_snapshots: [],
    memory_candidates: [],
    execution_records: [],
    summary: "",
    created_at: "2026-09-11T00:00:00.000Z",
    updated_at: "2026-09-11T00:00:00.000Z"
  }];
  storage.saveState(state);
  const service = reviewChat.createReviewChatService({
    storage,
    invokeModel: async () => ({
      ok: true,
      data: {
        intent: "local_review",
        answer: "已围绕当前选区触发付款专项审查。",
        citations: [],
        risk_candidates: [],
        review_action: { type: "local_review", review_type: "legal_risk", topic: "payment", context_scope: "adjacent_clauses", selection_ref: "selection-1" },
        memory_candidates: []
      }
    })
  });

  const result = await service.chat({
    projectId: "project-chat",
    sessionId: "chat_session_existing",
    userInput: "重新审查这个选区",
    modelName: "analysis-main",
    currentPage: 1,
    selectionRef: "selection-1"
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.intent, "local_review");
  const saved = storage.loadState();
  const review = saved.reviews["project-chat"];
  assert.equal(review.risks[0].source_type, "chat_local_review");
  assert.equal(review.risks[0].contract_location.text_hash, "fnv1a-test");
  assert.match(review.chat_sessions[0].summary, /历史审查消息/);
  assert.ok(review.chat_sessions[0].summary_checkpoint?.message_count >= 12);
});

test("临时选区生成文本哈希且记忆写入禁用策略在主进程生效", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-policy-chat-"));
  const storage = createStorage(root);
  const state = baseState();
  state.settings.chatPermissions.memoryWrite = "deny";
  storage.saveState(state);
  const service = reviewChat.createReviewChatService({
    storage,
    invokeModel: async () => ({
      ok: true,
      data: {
        intent: "local_review",
        answer: "已触发临时选区局部审查。",
        citations: [],
        risk_candidates: [],
        review_action: { type: "local_review", review_type: "legal_risk", topic: "payment", context_scope: "selected_clause" },
        memory_candidates: [{ content: "采购预付款需要审批", scope: "contract_type:procurement" }]
      }
    })
  });
  const result = await service.chat({
    projectId: "project-chat",
    userInput: "审查刚刚划出的内容",
    modelName: "analysis-main",
    currentPage: 1,
    selection: { text: "预付款为合同金额的 40%。", file_version_id: "contract_v1", page: 1, clause_no: "1.2", char_range: [24, 40] }
  });
  assert.equal(result.ok, true);
  const review = result.state.reviews["project-chat"];
  assert.match(review.risks[0].contract_location.text_hash, /^sha256:/);
  const denied = service.confirmMemory({
    projectId: "project-chat",
    sessionId: result.sessionId,
    candidateId: result.response.memory_candidate_refs[0]
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, "MEMORY_WRITE_DENIED");
  assert.equal(storage.loadState().knowledge.memory.length, 1);
});

test("用户取消后即使模型适配器忽略信号也不会保存成功结果", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-cancel-chat-"));
  const storage = createStorage(root);
  storage.saveState(baseState());
  const service = reviewChat.createReviewChatService({
    storage,
    invokeModel: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, data: { intent: "answer", answer: "不应保存的成功回答", citations: [], risk_candidates: [], memory_candidates: [] } };
    }
  });
  const pending = service.chat({ projectId: "project-chat", requestId: "request-cancel", userInput: "检查付款条款", modelName: "analysis-main" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cancellation = service.cancel({ requestId: "request-cancel" });
  assert.equal(cancellation.ok, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MODEL_REQUEST_CANCELLED");
  assert.equal(storage.loadState().reviews["project-chat"].chat_sessions[0].messages.at(-1).status, "cancelled");
});

test("natural-language risk without model quote is anchored back to contract text", () => {
  assert.equal(typeof reviewChat.normalizeRisk, "function");
  const risk = reviewChat.normalizeRisk({
    title: "Excessive prepayment",
    analysis: "The contract says prepayment is 40% of contract amount.",
    risk_category: "commercial"
  }, {
    review: {
      project: { file_version_id: "contract_v1" },
      document: {
        pages: [{ page: 1, text: "Clause 1.2 Payment: Prepayment is 40% of contract amount." }]
      }
    },
    currentPage: 1
  });

  assert.equal(risk.contract_location.file_version_id, "contract_v1");
  assert.equal(risk.contract_location.page, 1);
  assert.match(risk.contract_location.quote, /Prepayment is 40% of contract amount/);
  assert.deepEqual(risk.contract_location.char_range, [20, 56]);
  assert.ok(risk.location_confidence >= 0.7);
});

test("risk without any textual match remains unresolved without unrelated page text", () => {
  const risk = reviewChat.normalizeRisk({
    title: "Potential issue",
    analysis: "Further legal review is required."
  }, {
    review: {
      project: { file_version_id: "contract_v1" },
      document: { pages: [{ page: 2, text: "2.1 Delivery date shall be confirmed by both parties." }] }
    },
    currentPage: 2
  });

  assert.equal(risk.contract_location.page, null);
  assert.equal(risk.contract_location.quote, "");
  assert.equal(risk.contract_location.location_status, "unresolved");
  assert.equal(risk.location_confidence, 0);
});
