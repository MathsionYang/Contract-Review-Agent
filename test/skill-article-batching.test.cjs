const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parseContract } = require("../electron/parser.cjs");
const { extractionBatches, extractWithModel } = require("../electron/model-extraction.cjs");
const { analyzeBlocks, analyzeContract, readBlocks } = require("../electron/clause-skill.cjs");
const { runReview } = require("../electron/review-runner.cjs");

const CONTRACT = path.join(__dirname, "..", "data", "软件采购合同.docx");
const MODEL = { configId: "ex", name: "m", modelId: "m", role: "extraction", status: "active", testStatus: "passed",
  endpoint: "x", credentialRef: "none", contextLength: 16000, maxTokens: 4096, timeoutMs: 60000 };

async function realAnalysis() {
  const document = await parseContract(CONTRACT);
  const read = await readBlocks(CONTRACT);
  assert.equal(read.ok, true, read.message || "Skill 必须能读取真实合同");
  return { document, analysis: analyzeBlocks(read.data.blocks, document) };
}

test("相邻短条合并成批，不把批次数放大到每条一次", async () => {
  const { document, analysis } = await realAnalysis();
  assert.ok(analysis.articles.length >= 5, `应识别出多条，实际 ${analysis.articles.length}`);
  const plain = extractionBatches(document, MODEL, {});
  const grouped = extractionBatches(document, MODEL, { articleBoundaries: analysis });
  // 回归：早先"一条一批"会把 2 个批次放大成 13 个。合并后必须与顺序装批持平，
  // 因为系统提示词的固定开销远大于这些小条的正文。
  assert.ok(grouped.length <= plain.length + 1,
    `按条装批不应显著增加批次数：顺序 ${plain.length} 批 vs 按条 ${grouped.length} 批`);
  // 每一批都必须覆盖到真实的条号，否则"这批抽哪几条"就是空信息
  for (const batch of grouped) {
    assert.ok(Array.isArray(batch.clause_nos) && batch.clause_nos.length, "每批都必须记录覆盖的条号");
    assert.equal(new Set(batch.clause_nos).size, batch.clause_nos.length, "条号不得重复");
  }
  // 所有条都必须被某一批覆盖到，不能漏条
  const covered = new Set(grouped.flatMap((batch) => batch.clause_nos));
  for (const article of analysis.articles) {
    assert.ok(covered.has(article.clause_no), `条 ${article.clause_no} 未被任何批次覆盖`);
  }
});

test("首条标题之前的前言内容不被记成第一条", async () => {
  // 前言块（合同名、编号、主体表）出现在首条标题之前，容易被误归到第一条名下，
  // 那样"本批覆盖第一条"就变成假信息。真实合同上这条路径会重复计入首条。
  const text = "合同名称\n第一条 甲方向乙方付款 30%。\n第二条 乙方交付。";
  const document = { text, documentType: "docx", pages: [{ page: 1, text }],
    blocks: [
      { block_id: "b1", page: null, logical_page: 1, text: "合同名称" },
      { block_id: "b2", page: null, logical_page: 1, text: "第一条 甲方向乙方付款 30%。" },
      { block_id: "b3", page: null, logical_page: 1, text: "第二条 乙方交付。" }
    ] };
  const boundaries = { articles: [{ clause_no: "第一条", block_id: "b2" }, { clause_no: "第二条", block_id: "b3" }] };
  const batches = extractionBatches(document, MODEL, { articleBoundaries: boundaries });
  assert.equal(batches.length, 1, "两条都很小时应合并成一批");
  const batch = batches[0];
  assert.ok(batch.blocks.some((block) => block.block_id === "b1"), "前言块仍必须被抽取，只是不归条");
  // 前言不得产生额外条号：每个真实条号恰好出现一次
  assert.deepEqual(batch.clause_nos, ["第一条", "第二条"], `前言不得混入条号：${JSON.stringify(batch.clause_nos)}`);
  assert.equal(new Set(batch.clause_nos).size, batch.clause_nos.length, "条号不得重复");
  // 全部块都必须被抽取，不因归组而丢失
  assert.deepEqual(batch.blocks.map((block) => block.block_id), ["b1", "b2", "b3"]);
});

test("单条过大时保持独立成批，不被合并进相邻条", async () => {
  // 一条正文远超批次字符上限，必须自己成批，否则会退回"一次请求装整份合同"的老问题。
  const huge = "第一条 " + "甲方应按约定支付价款。".repeat(400);
  const document = { text: `${huge}\n第二条 乙方交付。`, documentType: "docx",
    pages: [{ page: 1, text: `${huge}\n第二条 乙方交付。` }],
    blocks: [{ block_id: "b1", page: null, logical_page: 1, text: huge },
      { block_id: "b2", page: null, logical_page: 1, text: "第二条 乙方交付。" }] };
  const boundaries = { articles: [{ clause_no: "第一条", block_id: "b1" }, { clause_no: "第二条", block_id: "b2" }] };
  const batches = extractionBatches(document, MODEL, { articleBoundaries: boundaries });
  assert.ok(batches.length >= 2, "超大条必须与后续条分开成批");
  assert.ok(batches.some((batch) => batch.clause_nos.includes("第二条")), "第二条必须单独成批");
});

test("条边界不可用时回退顺序装批，不影响抽取", async () => {
  const document = await parseContract(CONTRACT);
  const noModel = { ...MODEL, contextLength: 16000 };
  // 少于两条边界：没有分组意义，必须回退（而不是抛错或产出空批）
  const single = extractionBatches(document, noModel, { articleBoundaries: { articles: [{ clause_no: "第一条", block_id: "b1" }] } });
  const plain = extractionBatches(document, noModel, {});
  assert.equal(single.length, plain.length, "边界不足时应与顺序装批一致");
  // 完全没有边界
  assert.deepEqual(extractionBatches(document, noModel, { articleBoundaries: null }).length, plain.length);
  // 未对齐过多时 analyzeContract 的 ok 仍为真，但调用方必须据 unaligned 判定可靠性
  const analysis = await analyzeContract(CONTRACT, document);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.unaligned, 0, "真实合同应全部对齐");
});

test("审查链路用 Skill 条边界装批，并如实记录来源与覆盖条号", async () => {
  const document = await parseContract(CONTRACT);
  const result = await runReview({
    review: { project: { project_id: "wire", file_version_id: "v1", contract_type: "procurement", stored_path: CONTRACT },
      document, config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: "t", status: "queued", progress: 0 }, execution_summary: { extraction: { activities: [] } } },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [MODEL] }, settings: {} },
    services: { invokeModel: async () => ({ ok: true, data: { facts: [] } }) }
  });
  const summary = result.review.execution_summary.extraction;
  assert.equal(summary.article_source, "skill", "有原始文件时应使用 Skill 条边界");
  assert.ok(summary.article_count >= 5, `应记录识别到的条数，实际 ${summary.article_count}`);
  assert.equal(summary.clause_progress.length, summary.total_batches, "每批都要有覆盖条号记录");
  for (const entry of summary.clause_progress) assert.ok(entry.clause_nos.length, `批 ${entry.batch} 缺少覆盖条号`);
  // 条边界解析必须留痕，便于定位"这批为什么这么切"
  assert.equal(summary.article_boundaries?.source, "skill");
  assert.equal(summary.article_boundaries?.reliable, true);
  const timeline = (summary.activities || []).map((item) => item.event);
  assert.ok(timeline.includes("article_boundaries"), "时间线必须记录条边界解析");
});

test("没有本地副本时回退顺序装批且不阻断审查", async () => {
  const document = await parseContract(CONTRACT);
  // 历史任务可能没有 stored_path：Skill 读不到原始文件，必须回退而不是让审查失败
  const result = await runReview({
    review: { project: { project_id: "nofile", file_version_id: "v1", contract_type: "procurement" },
      document, config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: "t2", status: "queued", progress: 0 }, execution_summary: { extraction: { activities: [] } } },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [MODEL] }, settings: {} },
    services: { invokeModel: async () => ({ ok: true, data: { facts: [] } }) }
  });
  const summary = result.review.execution_summary.extraction;
  assert.equal(summary.article_source, "none");
  assert.equal(summary.article_boundaries?.source, "unavailable");
  assert.ok(summary.total_batches >= 1, "回退后仍必须完成抽取");
  assert.equal(result.review.task.status, "completed");
});
