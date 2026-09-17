const test = require("node:test");
const assert = require("node:assert/strict");
const { runReview } = require("../electron/review-runner.cjs");
const { extractWithModel } = require("../electron/model-extraction.cjs");
const { invokeModel } = require("../electron/model-gateway.cjs");

const REASONING_TEXT = "内部推理原文不得外发：预付款 40% 超出制度";

const EXTRACTION_MODEL = { configId: "cfg-extract", name: "extract-model", modelId: "m-extract", role: "extraction", status: "active", testStatus: "passed", contextLength: 8000, maxTokens: 1024 };
const ANALYSIS_MODEL = { configId: "cfg-analysis", name: "analysis-model", modelId: "m-analysis", role: "analysis", status: "active", testStatus: "passed", contextLength: 16000, maxTokens: 2048 };

function document() {
  const text = "第四条 付款\n预付款 40%。\n第五条 保密";
  return { documentType: "docx", fileVersionId: "contract_v1", text, sha256: "hash", pages: [{ page: 1, text }],
    blocks: [{ block_id: "b1", text, char_range: [0, text.length], logical_page: 1 }] };
}

function state() {
  return {
    knowledge: { legalSnapshots: [], rules: [{ file: "payment-rules", selected: true, clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款比例不得超过 30%" }] }], policies: [] },
    capabilities: { models: [EXTRACTION_MODEL, ANALYSIS_MODEL], skills: [] },
    settings: {}
  };
}

function reviewInput() {
  return {
    project: { project_id: "p", file_version_id: "contract_v1", contract_type: "procurement" },
    document: document(),
    config: { snapshot: { id: "", status: "draft" }, rules: ["payment-rules"], policies: [] },
    task: { task_id: "t", status: "queued", progress: 0 },
    risks: []
  };
}

test("抽取改为流式请求，实时上报已接收字数并记录推理时间线", async () => {
  const events = [];
  const extractEvents = [];
  await runReview({
    review: reviewInput(),
    state: state(),
    onProgress: (event) => events.push(event),
    services: {
      invokeModel: async (request) => {
        // 抽取必须走流式，否则等待期间界面没有任何可见进展。
        if (request.model.role === "extraction") {
          assert.equal(request.stream, true, "抽取请求必须启用流式");
          assert.equal(typeof request.onDelta, "function");
          request.onDelta('{"facts":[{"fact_type":"ratio"');
          request.onDelta(',"value":0.4,"raw_text":"预付款 40%","clause_no":"第四条","block_id":"b1"}]}');
          assert.equal(typeof request.onReasoningDelta, "function");
          request.onReasoningDelta(REASONING_TEXT);
          return { ok: true, data: { facts: [{ fact_type: "ratio", value: 0.4, raw_text: "预付款 40%", clause_no: "第四条", block_id: "b1" }] } };
        }
        return { ok: false, errorCode: "MODEL_CONFIG_INVALID", message: "分析模型未在本用例中使用" };
      }
    }
  });
  // 抽取阶段的心跳：进度事件里能看到持续增长的接收字数与推理活跃字数。
  const extractionSnapshots = events.map((event) => event.executionSummary?.extraction).filter(Boolean);
  assert.ok(extractionSnapshots.some((summary) => summary.received_char_count > 0), "必须上报已接收字数");
  assert.ok(extractionSnapshots.some((summary) => summary.reasoning_char_count > 0), "必须上报推理活跃字数");
  assert.ok(extractionSnapshots.some((summary) => summary.phase === "receiving"), "必须报告正在接收输出");
  const timeline = extractionSnapshots.at(-1).activities.map((entry) => entry.event);
  assert.ok(timeline.includes("requesting"), "时间线必须包含已提交请求");
  assert.ok(timeline.includes("batch_completed"), "时间线必须包含批次完成");
  // 时间线与进度事件都不得携带推理原文。
  assert.equal(JSON.stringify(events).includes(REASONING_TEXT), false);
});

test("抽取进度事件不含模型原始输出，只含原文预览与已校验事实", async () => {
  const events = [];
  await extractWithModel(document(), {
    model: EXTRACTION_MODEL,
    onProgress: (summary) => events.push(summary),
    invokeModel: async (request) => {
      request.onDelta('{"facts":[{"raw_text":"伪造原文不能显示","value":0.9}]}');
      request.onReasoningDelta(REASONING_TEXT);
      return { ok: true, data: { facts: [{ fact_type: "ratio", value: 0.9, raw_text: "伪造原文不能显示", block_id: "b1", clause_no: "第四条" }] } };
    }
  });
  assert.ok(events.some((summary) => summary.received_char_count > 0));
  assert.equal(JSON.stringify(events).includes("伪造原文不能显示"), false);
  assert.equal(JSON.stringify(events).includes(REASONING_TEXT), false);
});

test("语义分析在等待与接收期间持续上报，并记录首段响应与候选风险事件", async () => {
  const events = [];
  let finish;
  const pending = runReview({
    review: reviewInput(),
    state: state(),
    onProgress: (event) => events.push(event),
    services: {
      invokeModel: async (request) => {
        if (request.model.role === "extraction") return { ok: true, data: { facts: [] } };
        request.onReasoningDelta(REASONING_TEXT);
        request.onDelta('{"risks":[{"title":"预付款风险","quote":"预付款 40%。"}]}');
        return new Promise((resolve) => { finish = () => resolve({ ok: true, data: { risks: [] } }); });
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const analysisEvents = events.map((event) => event.executionSummary?.analysis).filter(Boolean);
  assert.ok(analysisEvents.some((summary) => summary.reasoning_char_count > 0), "推理活跃度必须可见");
  assert.ok(analysisEvents.some((summary) => summary.first_response_at), "必须记录首段响应时间");
  const timeline = analysisEvents.at(-1).activities.map((entry) => entry.event);
  assert.ok(timeline.includes("requesting"));
  assert.ok(timeline.includes("first_delta"));
  assert.ok(timeline.includes("risk_received"));
  assert.equal(JSON.stringify(events).includes(REASONING_TEXT), false);
  finish();
  await pending;
});

test("停止请求发出后进度事件报告 cancelling，而不是继续报告执行中", async () => {
  const { applyReviewProgress } = await import("../src/services/reviewProgress.mjs");
  const controller = new AbortController();
  const events = [];
  let release;
  const pending = runReview({
    review: reviewInput(),
    state: state(),
    onProgress: (event) => events.push(event),
    services: {
      signal: controller.signal,
      invokeModel: async (request) => {
        if (request.model.role === "extraction") return { ok: true, data: { facts: [] } };
        request.onDelta('{"risks":[{"title":"已生成风险","quote":"预付款 40%。"}]}');
        controller.abort();
        return new Promise((resolve) => { release = () => resolve({ ok: false, errorCode: "MODEL_REQUEST_CANCELLED", message: "模型请求已取消" }); });
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 中断信号已发出，但任务尚未收尾：此时主进程上报的状态必须是 cancelling。
  const review = { project: { file_version_id: "contract_v1" }, risks: [], task: { status: "running", current_step: "model", progress: 70 } };
  events.push({ runId: "r", projectId: "p", fileVersionId: "contract_v1", sequence: 1, step: "model", progress: 70, status: "cancelling" });
  const run = { id: "r", projectId: "p", sequence: 0 };
  const payload = events.at(-1);
  applyReviewProgress(review, payload, run);
  // 渲染层必须采用主进程状态：停止请求发出后不能被此前的 running 覆盖。
  assert.equal(review.task.status, "cancelling");
  release();
  const result = await pending;
  assert.equal(result.review.task.status, "cancelled");
  assert.ok(result.review.risks.length > 0);
});

test("渲染层保留主进程上报的 cancelling，而不是回退成 running", async () => {
  const { applyReviewProgress } = await import("../src/services/reviewProgress.mjs");
  const review = { project: { file_version_id: "v1" }, risks: [], task: { status: "running", current_step: "model", progress: 70 } };
  const run = { id: "run-1", projectId: "p", sequence: 0 };
  const next = applyReviewProgress(review, { runId: "run-1", projectId: "p", fileVersionId: "v1", sequence: 1,
    status: "cancelling", step: "model", progress: 70 }, run);
  assert.equal(next.status, "cancelling");
  assert.equal(review.task.status, "cancelling");
  // 主进程未给出状态时才回退到任务当前状态，避免丢失中断信息。
  const fallback = applyReviewProgress(review, { runId: "run-1", projectId: "p", fileVersionId: "v1", sequence: 2, step: "model", progress: 70 }, run);
  assert.equal(fallback.status, "cancelling");
});

test("模型网关把推理增量回调给调用方，但仍只返回结构化数据", async () => {
  const reasoning = [];
  const deltas = [];
  const model = { name: "m", modelId: "m", role: "analysis", endpoint: "https://example.invalid/v1/chat/completions", timeoutMs: 5000 };
  const frame = (payload) => `data: ${JSON.stringify({ choices: [{ delta: payload }] })}\n\n`;
  const result = await invokeModel({
    model,
    stream: true,
    onDelta: (value) => deltas.push(value),
    onReasoningDelta: (value) => reasoning.push(value),
    fetchImpl: async () => ({ ok: true, body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ reasoning_content: REASONING_TEXT })));
      controller.enqueue(new TextEncoder().encode(frame({ content: '{"risks":[]}' })));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    } }) })
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { risks: [] });
  assert.deepEqual(reasoning, [REASONING_TEXT]);
  assert.deepEqual(deltas, ['{"risks":[]}']);
});
