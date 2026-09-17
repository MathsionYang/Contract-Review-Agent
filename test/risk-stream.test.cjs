const test = require("node:test");
const assert = require("node:assert/strict");
const { createRiskStream } = require("../electron/risk-stream.cjs");
const { runReview } = require("../electron/review-runner.cjs");
const { invokeModel } = require("../electron/model-gateway.cjs");

test("风险对象闭合即发布，跨字符、转义和嵌套字段不会提前生成风险", () => {
  const events = [];
  const stream = createRiskStream((risk, index) => events.push({ risk, index }));
  const first = { title: "付款风险", quote: 'a\\b"c}中文', checklist_ids: ["GC-1-01"], meta: { title: "嵌套标题" } };
  const prefix = "```json\n{\"risks\":[" + JSON.stringify(first);
  for (const char of prefix.slice(0, -1)) stream.write(char);
  assert.equal(events.length, 0);
  stream.write(prefix.at(-1));
  assert.deepEqual(events, [{ risk: first, index: 0 }]);
  stream.write(',{"title":"第二条","quote":"未闭合');
  assert.equal(events.length, 1);
  stream.write('"}]}\n```');
  assert.equal(events.length, 2);
  assert.equal(events[1].index, 1);
  stream.write("ignored");
  assert.equal(events.length, 2);
});

test("跳过非法风险、无关字段及坏流，已发布的完整风险不丢失", () => {
  const found = [];
  const stream = createRiskStream((risk) => found.push(risk));
  stream.write('{"other":{"title":"not a risk"},"risks":[null,0,{},[],{"title":""},{"title":"ok"}, broken');
  stream.write('{"title":"late"}]}');
  assert.deepEqual(found, [{ title: "ok" }]);
});

function reviewInput() {
  const text = "预付款 40%。逾期付款应当支付违约金。";
  return {
    review: {
      project: { project_id: "p", file_version_id: "v1", contract_type: "procurement" },
      config: { rules: ["payment"], policies: [] },
      document: { text, pages: [{ page: 1, text }] },
      risks: [{ risk_id: "old" }]
    },
    state: {
      knowledge: { rules: [{ file: "payment", selected: true, clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款不得超过 30%" }] }] },
      capabilities: { models: [{ name: "mock", role: "analysis", status: "active" }] }
    }
  };
}

test("编排在模型完成前逐条发布，并与最终结果保持 ID 和数量一致", async () => {
  const events = [];
  let finish;
  let started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  const raw = { title: "检查付款", quote: "预付款 40%。", risk_id: "provider-id", risk_level: "high" };
  const second = { ...raw, title: "检查违约金", quote: "逾期付款应当支付违约金。" };
  const promise = runReview({
    ...reviewInput(), onProgress: (event) => events.push(event),
    services: { invokeModel: (request) => {
      assert.equal(request.stream, true);
      request.onDelta('{"risks":[' + JSON.stringify(raw));
      const streamed = events.filter((event) => event.step === "model" && event.riskUpdate?.type === "upsert");
      assert.equal(streamed.length, 1);
      assert.equal(streamed[0].riskUpdate.risk.human_status, "pending_review");
      return new Promise((resolve) => { finish = () => {
        request.onDelta("," + JSON.stringify(second) + "]}");
        resolve({ ok: true, data: { risks: [raw, second] } });
      }; started(); });
    } }
  });
  assert.equal(events[0].riskUpdate.type, "reset");
  await modelStarted;
  assert.equal(new Set(events.filter((event) => event.riskUpdate?.type === "upsert").map((event) => event.riskUpdate.risk.risk_id)).size, 2);
  finish();
  const result = await promise;
  const live = new Map(events.filter((e) => e.riskUpdate?.type === "upsert").map((e) => [e.riskUpdate.risk.risk_id, e.riskUpdate.risk]));
  assert.equal(live.size, 3);
  assert.deepEqual([...live.values()], JSON.parse(JSON.stringify(result.review.risks)));
  assert.equal(result.review.execution_summary.analysis.received_risk_count, 2);
  assert.equal(events.at(-1).riskCount, 3);
  assert.equal(events.at(-1).status, "completed");
});

test("超时或抛错时保留完整模型候选，不接收半条风险或伪造完成状态", async () => {
  const result = await runReview({
    ...reviewInput(),
    services: { invokeModel: async ({ onDelta }) => {
      onDelta('{"risks":[{"title":"已完成候选","quote":"预付款 40%。"},{"title":"半条');
      throw Object.assign(new Error("模型空闲超时"), { code: "MODEL_REQUEST_TIMEOUT" });
    } }
  });
  assert.equal(result.review.task.status, "partial");
  assert.equal(result.review.risks.length, 2);
  assert.equal(result.review.risks[1].title, "已完成候选");
  assert.equal(result.review.task.errors[0].code, "MODEL_REQUEST_TIMEOUT");
  assert.match(result.review.task.errors[0].message, /已保留 1 条/);
});

test("语义分析过程报告等待、首段响应、完整风险和失败终态，不透出半条或原始 JSON", async () => {
  const events = [];
  let started;
  let finish;
  const entered = new Promise((resolve) => { started = resolve; });
  const pending = runReview({ ...reviewInput(), onProgress: (event) => events.push(event), services: { invokeModel: (request) => {
    assert.equal(events.at(-1).executionSummary.analysis.phase, "requesting");
    request.onDelta('{"risks":[{"title":"完整风险","quote":"预付款 40%。"}');
    request.onDelta(',{"title":"半条风险不能展示');
    started();
    return new Promise((resolve) => { finish = () => resolve({ ok: false, errorCode: "MODEL_REQUEST_TIMEOUT", message: "等待响应超时" }); });
  } } });
  await entered;
  const receiving = events.findLast((event) => event.executionSummary?.analysis?.phase === "receiving").executionSummary.analysis;
  assert.equal(receiving.received_risk_count, 1);
  assert.equal(receiving.recent_risks[0].title, "完整风险");
  assert.equal(receiving.recent_risks[0].quote, "预付款 40%。");
  assert.ok(receiving.first_response_at);
  assert.ok(receiving.received_char_count > 0);
  assert.equal(events.some((event) => JSON.stringify(event.executionSummary).includes("半条风险不能展示")), false);
  assert.equal(events.some((event) => JSON.stringify(event.executionSummary).includes('"risks":[')), false);
  finish();
  const { review } = await pending;
  assert.equal(review.execution_summary.analysis.phase, "finished");
  assert.equal(review.execution_summary.analysis.status, "failed");
  assert.ok(review.execution_summary.analysis.completed_at);
  assert.equal(review.execution_summary.analysis.received_risk_count, 1);
  assert.equal(receiving.status, "running");
});

test("运行版本和事件序号隔离旧进度，重复 upsert 不增加风险数", async () => {
  const { applyReviewProgress } = await import("../src/services/reviewProgress.mjs");
  const review = { project: { file_version_id: "v1" }, risks: [{ risk_id: "old" }] };
  const run = { id: "run-1", projectId: "p", sequence: 0 };
  const event = { runId: run.id, projectId: "p", fileVersionId: "v1", sequence: 1, riskUpdate: { type: "reset" } };
  assert.equal(applyReviewProgress(review, event, run).riskCount, 0);
  const risk = { risk_id: "risk-1", title: "第一条", contract_location: { file_version_id: "v1" } };
  const next = { ...event, sequence: 2, riskCount: 99, riskUpdate: { type: "upsert", risk } };
  assert.equal(applyReviewProgress(review, next, run).riskCount, 1);
  assert.equal(applyReviewProgress(review, next, run), null);
  for (const patch of [{ runId: "old" }, { projectId: "other" }, { fileVersionId: "v0" }]) assert.equal(applyReviewProgress(review, { ...next, ...patch, sequence: 3 }, run), null);
  assert.equal(applyReviewProgress(review, { ...next, sequence: 3, riskUpdate: { type: "upsert", risk: { ...risk, title: "更新" } } }, run).latestRiskTitle, "更新");
  assert.equal(review.risks.length, 1);
  assert.equal(applyReviewProgress(review, { ...event, sequence: 4 }, null), null);
});

const model = { endpoint: "https://example.invalid/v1", modelId: "mock", timeoutMs: 1000, retries: 2 };
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
function responseStream(signal, schedule, closeAfter = true) {
  let timers = [];
  return { ok: true, body: new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => { timers.forEach(clearTimeout); controller.error(new Error("aborted")); }, { once: true });
      schedule.forEach(([delay, text], index) => timers.push(setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        if (closeAfter && index === schedule.length - 1) controller.close();
      }, delay)));
    },
    cancel() { timers.forEach(clearTimeout); }
  }) };
}

test("持续输出超过原空闲时限仍能完成，推理活动续期但不发给风险流", async () => {
  const deltas = [];
  const result = await invokeModel({
    model, stream: true, onDelta: (value) => deltas.push(value),
    fetchImpl: async (_url, options) => responseStream(options.signal, [
      [0, frame({ reasoning_content: "thinking" })],
      [500, frame({ reasoning_content: "still thinking" })],
      [1000, frame({ content: '{"risks":[' })],
      [1500, frame({ content: '{"title":"风险"}]}' }, "stop").trimEnd()]
    ])
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { risks: [{ title: "风险" }] });
  assert.equal(deltas.join(""), '{"risks":[{"title":"风险"}]}');
});

test("已开始输出后的空闲超时不重试，完整候选可供上层保留", async () => {
  let calls = 0;
  const risks = [];
  const parser = createRiskStream((risk) => risks.push(risk));
  const result = await invokeModel({
    model, stream: true, onDelta: parser.write,
    fetchImpl: async (_url, options) => { calls += 1; return responseStream(options.signal, [[0, frame({ content: '{"risks":[{"title":"保留"}' })]], false); }
  });
  assert.equal(result.errorCode, "MODEL_REQUEST_TIMEOUT");
  assert.match(result.message, /没有新内容/);
  assert.equal(calls, 1);
  assert.deepEqual(risks, [{ title: "保留" }]);
});

test("流式服务返回 JSON 也能解析，但长度截断必须标为未完成", async () => {
  let delta;
  const fallback = await invokeModel({
    model, stream: true, onDelta: (value) => { delta = value; },
    fetchImpl: async () => ({ ok: true, headers: { get: () => "application/json; charset=utf-8" }, body: { getReader() { throw new Error("must not read SSE"); } }, json: async () => ({ choices: [{ message: { content: '{"risks":[]}' } }] }) })
  });
  assert.equal(fallback.ok, true);
  assert.equal(delta, '{"risks":[]}');
  const truncated = await invokeModel({ model, stream: true, fetchImpl: async (_url, options) => responseStream(options.signal, [[0, frame({ content: '{"risks":[]}' }, "length")]]) });
  assert.equal(truncated.errorCode, "MODEL_OUTPUT_TRUNCATED");
  assert.equal(truncated.attempts, 1);
});

test("SSE 字节边界、UTF-8 字符和无换行尾帧可以正确拼接", async () => {
  const content = '{"risks":[{"title":"中文风险"}]}';
  const bytes = new TextEncoder().encode(frame({ content }) + "data: [DONE]");
  const result = await invokeModel({ model, stream: true, fetchImpl: async () => ({ ok: true, body: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }) }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, JSON.parse(content));
});

test("无效 SSE 和服务商错误不能变成空风险成功结果", async () => {
  for (const [text, code] of [["data: not-json\n\n", "MODEL_OUTPUT_INVALID"], [frame({ content: '{"risks":[' }) + 'data: {"error":{"message":"service failed"}}\n\n', "MODEL_REQUEST_FAILED"]]) {
    const result = await invokeModel({ model, stream: true, fetchImpl: async (_url, options) => responseStream(options.signal, [[0, text]]) });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, code);
    assert.equal(result.attempts, 1);
  }
});
