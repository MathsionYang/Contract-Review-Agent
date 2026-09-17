const test = require("node:test");
const assert = require("node:assert/strict");

// 核验弹窗是人工复核条款抽取的唯一入口，这里锁定它的关键呈现：
// 事实表格、来源区分、以及"为什么被丢弃"的原因分布。
async function renderModal(review) {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  try {
    const { default: ExtractionReview } = await server.ssrLoadModule("/src/components/ExtractionReview.vue");
    const app = createSSRApp(ExtractionReview, { review });
    app.config.warnHandler = () => {};
    return await renderToString(app);
  } finally {
    await server.close();
  }
}

function fact(patch) {
  return {
    fact_id: `f_${patch.raw_text}`,
    fact_type: "money",
    raw_text: "人民币壹佰万元整",
    value: "1000000",
    clause_no: "2.1",
    confidence: 0.8,
    origin: "rules",
    source_refs: [{ block_id: "docx_block_42", logical_page: 2, char_range: [10, 22], quote: "人民币壹佰万元整" }],
    ...patch
  };
}

function reviewFixture(patch = {}) {
  return {
    project: { project_id: "p1", project_name: "采购合同", file_version_id: "contract_v1" },
    document: { fileName: "采购合同.docx", documentType: "docx" },
    contract_facts: [
      fact({}),
      fact({ fact_id: "f2", fact_type: "ratio", value: 0.3, raw_text: "30%", clause_no: "2.3", origin: "model", source_refs: [{ block_id: "docx_block_75", logical_page: 2 }] }),
      fact({ fact_id: "f3", fact_type: "duration", value: 60, unit: "日", calendar_type: "calendar_day", raw_text: "60 个自然日", clause_no: "3.1", origin: "model", source_refs: [{ block_id: "docx_block_80", logical_page: 3 }] })
    ],
    execution_summary: { extraction: { call_count: 2, baseline_fact_count: 1, accepted_fact_count: 2, duplicate_fact_count: 0,
      rejected_fact_count: 5, out_of_scope_fact_count: 1,
      rejection_reasons: { quote_not_found: 3, value_mismatch: 2 }, rejected_fact_types: { money: 3, duration: 2 } } },
    ...patch
  };
}

test("核验弹窗列出抽取事实，并区分规则与模型来源", async () => {
  const html = await renderModal(reviewFixture());
  assert.ok(html.includes("条款与事实抽取核验"));
  // 三条事实都要出现
  assert.ok(html.includes("人民币壹佰万元整"));
  assert.ok(html.includes("30%"));
  assert.ok(html.includes("60 个自然日"));
  // 类型与来源标签
  assert.ok(html.includes("金额") && html.includes("比例") && html.includes("期限"));
  assert.ok(html.includes("模型") && html.includes("规则"), "必须区分模型与规则来源");
  // 期限要把单位与日历类型展示出来，便于核验
  assert.ok(html.includes("calendar_day"), "期限事实必须展示日历类型");
  // 定位信息
  assert.ok(html.includes("docx_block_42"));
  assert.ok(html.includes("逻辑页 2") || html.includes("逻辑页 3"));
});

test("核验弹窗把丢弃原因讲清楚，并说明丢弃不等于抽取失败", async () => {
  const html = await renderModal(reviewFixture());
  assert.ok(html.includes("丢弃原因分布"));
  assert.ok(html.includes("原文中不存在该引文"), "必须用可读文案解释 quote_not_found");
  assert.ok(html.includes("数值与引文不一致"), "必须用可读文案解释 value_mismatch");
  assert.ok(html.includes("3 条") && html.includes("2 条"), "必须给出各类原因的数量");
  // 关键澄清：避免用户以为抽取坏了
  assert.ok(html.includes("被丢弃"), "必须解释丢弃的含义");
  assert.ok(html.includes("本地校验拦住了模型编造的内容"), "必须说明丢弃属于保护机制");
});

test("没有事实时给出明确空态，而不是空白窗口", async () => {
  const html = await renderModal(reviewFixture({ contract_facts: [], execution_summary: null }));
  assert.ok(html.includes("还没有抽取事实"));
  assert.equal(html.includes("丢弃原因分布"), false, "无事实时不显示诊断区");
});

test("抽取正常无丢弃时明确说明，而不是留空", async () => {
  const review = reviewFixture();
  review.execution_summary.extraction.rejection_reasons = {};
  review.execution_summary.extraction.rejected_fact_count = 0;
  const html = await renderModal(review);
  assert.ok(html.includes("没有因校验未通过被丢弃的事实"));
});
