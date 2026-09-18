const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runContractChecks } = require("../electron/contract-checks.cjs");
const { extractContractFacts } = require("../electron/contract-facts.cjs");
const { parseContract } = require("../electron/parser.cjs");

// 复刻"报告合同"的关键形状：小写总价带两位小数、明细表用「序号/设备名称」而非「项目」、
// 价款在第 3.1 条（不是 2.1）、签约后一次付 100%（没有分期）。
function reportLikeDocument() {
  const text = [
    "第三条 合同价款",
    "3.1 本合同总价为人民币贰佰陆拾捌万元整（小写：¥2,860,000.00 元）。该价格为含税价格。",
    "第四条 付款方式",
    "4.1 本合同签订后五个工作日内，甲方向乙方支付合同总价的 100%，即人民币贰佰陆拾捌万元整（¥2,860,000.00）。",
    "13.5 在任何情况下，乙方就本合同向甲方承担的赔偿责任累计不超过合同总价的 5%，且乙方不承担任何间接损失、可得利益损失、数据损失及停产损失。",
    "12.3 甲方违反本条保密义务的，应赔偿乙方因此遭受的全部损失。",
    "12.1 甲方应对保密信息保密。12.4 本条约定的保密义务在本合同终止后继续有效。"
  ].join("\n");
  // 8 行 × 7 列表格，表头用真实采购合同的写法（没有「项目」列）
  const header = ["序号", "设备名称", "规格型号", "单位", "数量", "单价（元）", "金额（元）"];
  const rows = [
    ["1", "AGV 智能搬运机器人", "HR-AGV800", "台", "24", "46,800.00", "1,123,200.00"],
    ["2", "巷道堆垛机", "HR-SRM1200", "台", "5", "128,500.00", "642,500.00"],
    ["3", "重型横梁式货架", "HR-RK4500", "组", "180", "2,350.00", "423,000.00"],
    ["4", "仓储管理系统软件", "HR-WMS V3.2", "套", "1", "320,000.00", "320,000.00"],
    ["5", "输送线系统", "HR-CV600", "米", "260", "980.00", "254,800.00"],
    ["6", "电气控制柜", "HR-EC400", "套", "5", "19,300.00", "96,500.00"],
    ["合计", "—", "—", "—", "—", "—", "2,860,000.00"]
  ];
  const blocks = [];
  let n = 0;
  const push = (text, table_ref) => { n += 1; blocks.push({ block_id: `docx_block_${n}`, page: null, logical_page: 1, text, ...(table_ref ? { table_ref } : {}) }); };
  push(text);
  for (const [rowIndex, row] of [header, ...rows].entries()) {
    for (const [column, cell] of row.entries()) push(cell, { table_id: "table_1", row: rowIndex, column });
  }
  return { text, documentType: "docx", fileVersionId: "report-like-v1", pages: [{ page: 1, text }], blocks };
}

function checkOf(document, contractType, id) {
  const facts = extractContractFacts(document, { contractType });
  const result = runContractChecks({ document, facts, contractType });
  return { check: (result.checkResults || []).find((item) => item.check_id === id), result, facts };
}

test("带小数点的金额不被过滤，大小写总价能配对并报出不一致", async () => {
  // 回归：moneyFacts 原先用 /^\d+$/ 只接受整数，把 "2860000.00" 这类金额整体丢弃，
  // 而合同的小写总价恰恰总写成 ¥2,860,000.00 —— 于是大小写配对、明细交叉核对全部退化为"未能提供"。
  const document = reportLikeDocument();
  const { check } = checkOf(document, "procurement", "amount.total_vs_uppercase");
  assert.equal(check.status, "conflict", check.message);
  assert.match(check.message, /2680000/, "必须报出大写金额");
  assert.match(check.message, /2860000/, "必须报出小写金额");
});

test("明细表表头不是「项目」时仍能识别金额列", async () => {
  // 回归：priceTableSummary 原先要求表里必须有一列叫「项目」，
  // 真实采购合同的表头是「序号／设备名称／规格型号／单位／数量／单价（元）／金额（元）」，
  // 没有「项目」列 → 整表被 continue 跳过 → 报"未能完整抽取明细金额"，而数据其实完整。
  const document = reportLikeDocument();
  const { check } = checkOf(document, "procurement", "amount.item_sum");
  assert.equal(check.status, "pass", check.message);
  assert.match(check.message, /2860000/, "应算出明细合计 2860000");
});

test("明细合计与小写总价不一致时给出冲突并指出锚点", async () => {
  const document = reportLikeDocument();
  // 把小写总价改成 2,680,000，使其与明细合计 2,860,000 不一致
  document.text = document.text.replace("2,860,000.00 元", "2,680,000.00 元");
  document.pages = [{ page: 1, text: document.text }];
  document.blocks[0].text = document.text;
  const { check } = checkOf(document, "procurement", "amount.item_sum");
  assert.equal(check.status, "conflict", check.message);
});

test("没有分期安排时判为不适用，不占用 critical", async () => {
  // 回归：原实现把"少于三期"判为 unverifiable 并挂 critical，
  // 而"签约后一次付清 100%"根本没有分期——真缺陷被一条解析自述盖住，critical 也被占用。
  const document = reportLikeDocument();
  const { check } = checkOf(document, "procurement", "amount.schedule_ratio_sum");
  assert.equal(check.status, "not_applicable", check.message);
});

test("违约金费率不会被误当成付款分期条款", async () => {
  // 回归：比例最密集的条常是违约金条款（0.5%／0.005%／1%），
  // 仅按"比例最多"定位分期会把违约金当成付款计划，报出无意义的"分期合计 1%"。
  const text = [
    "第四条 付款方式",
    "4.1 合同签订后支付 30%，验收合格后支付 60%，质保期满支付 10%。",
    "13.1 甲方逾期付款的，每逾期一日按合同总价的 0.5% 支付违约金。",
    "13.2 甲方逾期付款还应按银行同期利率上浮 50% 的标准支付。",
    "13.3 乙方逾期交货的，每逾期一日按逾期部分货款的 0.005% 支付违约金，最高不超过 1%。"
  ].join("\n");
  const document = { text, documentType: "docx", fileVersionId: "penalty-v1",
    pages: [{ page: 1, text }], blocks: text.split("\n").map((line, index) => ({ block_id: `b${index + 1}`, page: null, logical_page: 1, text: line })) };
  const { check } = checkOf(document, "procurement", "amount.schedule_ratio_sum");
  assert.equal(check.status, "pass", `应识别出 30%+60%+10% 的付款计划而不是违约金费率：${check.message}`);
  assert.match(check.message, /100\.00%|合计/);
});

test("真实软件采购合同上金额链完整可判", async () => {
  const document = await parseContract(path.join(__dirname, "..", "data", "软件采购合同.docx"));
  document.fileVersionId = "contract_fixture_v1";
  for (const [id, expected] of [["amount.item_sum", "conflict"], ["amount.total_vs_uppercase", "conflict"], ["amount.schedule_ratio_sum", "conflict"]]) {
    const { check } = checkOf(document, "procurement", id);
    assert.equal(check.status, expected, `${id}: ${check.message}`);
  }
});

test("无原文定位的条目等级被压到 medium，且置信度为 0", async () => {
  // 回归：清单项自带的静态严重度会直接变成风险等级，
  // 导致"没找到"比"找到了"更容易被评为严重（实测 location_confidence=0 的 28 条里 12 条被判 high）。
  const { runGeneralChecklist } = require("../electron/general-checklist.cjs");
  const text = "1.1 软件服务合同，双方约定按期交付。";
  const document = { text, documentType: "docx", fileVersionId: "cap-v1", pages: [{ page: 1, text }],
    blocks: [{ block_id: "b1", page: null, logical_page: 1, text }] };
  const result = runGeneralChecklist({ document, contractType: "software" });
  const unanchored = result.findings.filter((finding) => finding.contract_location.location_status !== "resolved");
  assert.ok(unanchored.length > 0, "该夹具应产出无定位的清单条目");
  for (const finding of unanchored) {
    assert.ok(["medium", "low", "info"].includes(finding.risk_level),
      `${finding.rule_id} 无原文定位却给出 ${finding.risk_level}`);
    assert.equal(finding.location_confidence, 0, `${finding.rule_id} 无定位时置信度必须为 0`);
  }
});

test("责任上限存在时不得断言「未见上限」，保密赔偿存在时不得断言「未规定后果」", async () => {
  // 回归：这两条曾与原文直接相反，且方向有害（照建议"补一个上限"会把风险做大）。
  const document = reportLikeDocument();
  for (const [id, expected] of [["liability.broad_indirect_loss", "unverifiable"], ["completeness.confidentiality_remedy", "pass"]]) {
    const { check } = checkOf(document, "procurement", id);
    assert.equal(check.status, expected, `${id}: ${check.message}`);
  }
  const cap = checkOf(document, "procurement", "liability.broad_indirect_loss").check;
  assert.ok(!/未见.*(?:上限|责任上限)/.test(cap.message), `不得断言未见上限：${cap.message}`);
  assert.match(cap.message, /上限/, "应说明已发现责任上限");
});
