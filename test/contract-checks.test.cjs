const test = require("node:test");
const assert = require("node:assert/strict");

const { extractContractFacts } = require("../electron/contract-facts.cjs");
const { runContractChecks } = require("../electron/contract-checks.cjs");

test("明细金额必须逐行计算，不能把单价和金额组合凑成合计", () => {
  const check = (rows) => {
    const text = `2.2 合同价款构成如下：序号 项目 数量 单价（元） 金额（元） ${rows} 2.3 价款支付方式`;
    const document = { text, pages: [{ page: 1, text }] };
    return runContractChecks({ document, facts: extractContractFacts(document) }).checkResults.find((c) => c.check_id === "amount.item_sum");
  };
  const wrongTotal = check("1 软件许可 2 用户 1,000 2,000 2 实施 1 项 1,000 1,000 — 合计 — — 5,000");
  assert.equal(wrongTotal.status, "conflict");
  assert.match(wrongTotal.message, /3000/);
  const wrongRow = check("1 软件许可 2 用户 1,000 3,000 2 实施 1 项 1,000 1,000 — 合计 — — 4,000");
  assert.equal(wrongRow.status, "conflict");
  assert.match(wrongRow.message, /单价乘数量与行金额不一致/);
  assert.equal(check("1 软件许可 2 用户 1,000 2,000 2 实施 1 项 1,000 1,000 — 合计 — — 3,000").status, "pass");
  assert.equal(check("1,000 2,000 1,000 1,000 — 合计 — — 5,000").status, "unverifiable");
});

const fixture = {
  fileVersionId: "contract_v1",
  text: [
    "甲方：瀚元智能装备制造有限公司，地址：湖南省长沙市岳麓区。乙方：云枢软件技术（武汉）有限公司，地址：湖北省武汉市东湖新技术开发区。",
    "2.1 本合同总价款为人民币壹佰贰拾捌万陆仟元整（小写：¥1,268,000 元）。",
    "2.2 合同价款构成合计 1,286,000 元。",
    "2.3 甲方向乙方支付合同总价款的 50%，即人民币 634,000 元；支付 40%，即人民币 507,200 元；支付 15%，即人民币 190,200 元。",
    "3.2 甲方负责服务器和网络安全等级保护备案，未按时完成视为甲方违约。",
    "3.3 甲方应向甲方提供软件安装介质。",
    "4.2 甲方应在收到申请后 10 个工作日内组织测试验收，满足甲方使用需求即为合格。",
    "4.3 初验合格后进入 30 个自然日试运行期，未发生重大故障即可终验。",
    "4.4 验收所需的一切检测、测试及第三方评估费用均由甲方承担。",
    "8.1 乙方逾期交付的，每逾期一日按合同总价款的万分之五支付违约金。",
    "8.2 甲方逾期付款的，每逾期一日按应付未付款项的万分之一支付违约金。",
    "8.3 乙方逾期超过 30 日的，除按第 8.1 条支付违约金外，另按合同总价款的 10% 支付违约金。",
    "8.4 因乙方原因造成甲方数据丢失，乙方向乙方支付违约金人民币 200,000 元。",
    "8.5 应赔偿全部损失，包括直接损失、间接损失、可得利益损失及第三方索赔。",
    "10.2 协商不成的，任何一方均可向乙方所在地人民法院提起诉讼。",
    "11.1 软件许可期限为永久，合同有效期三年。",
    "11.3 经双方协商一致可以解除。",
    "11.4 甲方应在系统交付后 15 个自然日内完成验收。"
  ].join("\n"),
  pages: [{ page: 1, text: "合同正文" }]
};

test("确定性检查覆盖金额时序主体责任缺失项和验收质量", () => {
  const facts = extractContractFacts(fixture, { contractType: "procurement" });
  const result = runContractChecks({ document: fixture, facts, contractType: "procurement" });
  const ids = new Set(result.checkResults.map((item) => item.check_id));

  for (const id of [
    "amount.total_vs_uppercase",
    "amount.item_sum",
    "amount.schedule_ratio_sum",
    "amount.schedule_amount_anchor",
    "timeline.acceptance_deadline_conflict",
    "timeline.trial_before_final_acceptance",
    "party.obligation_subject_inversion",
    "penalty.stacking",
    "penalty.unlimited_delay_cap",
    "liability.broad_indirect_loss",
    "dispute.counterparty_venue",
    "completeness.termination_right",
    "completeness.data_disposition",
    "completeness.ip_indemnity",
    "completeness.confidentiality_remedy",
    "completeness.compliance_warranty",
    "acceptance.subjective_standard",
    "acceptance.major_fault_undefined",
    "timeline.license_term_conflict"
  ]) assert.ok(ids.has(id), `missing check ${id}`);

  assert.ok(result.findings.some((item) => item.risk_topic === "amount_consistency"));
  assert.ok(result.findings.some((item) => item.risk_topic === "missing_clause" && item.conclusion_status === "needs_verification"));
  assert.ok(result.checkResults.every((item) => ["pass", "conflict", "missing", "unverifiable", "not_applicable"].includes(item.status)));
  assert.ok(result.findings.every((item) => item.contract_location && Array.isArray(item.contract_location.source_refs)));
});

test("确定性检查识别罚则费率不对称、时间单位混用和责任费用转嫁", () => {
  const facts = extractContractFacts(fixture, { contractType: "procurement" });
  const result = runContractChecks({ document: fixture, facts, contractType: "procurement" });
  const byId = new Map(result.checkResults.map((item) => [item.check_id, item]));

  assert.equal(byId.get("penalty.daily_rate_excessive")?.status, "conflict");
  assert.equal(byId.get("penalty.rate_asymmetry")?.status, "conflict");
  assert.equal(byId.get("timeline.calendar_unit_mixing")?.status, "conflict");
  assert.equal(byId.get("obligation.environment_transfer")?.status, "conflict");
  assert.equal(byId.get("acceptance.cost_allocation")?.status, "conflict");
});

test("无对方罚则时不虚构费率不对称，明确定义时间单位时不报混用", () => {
  const document = { text: "工作日指法定工作日，自然日包含节假日。交付期为30个自然日，通知期为5个工作日。乙方每逾期一日按合同总价万分之二支付违约金。" };
  const result = runContractChecks({ document, facts: extractContractFacts(document) });
  const checks = new Map(result.checkResults.map((c) => [c.check_id, c]));
  assert.equal(checks.get("penalty.rate_asymmetry").status, "unverifiable");
  assert.equal(checks.get("timeline.calendar_unit_mixing").status, "pass");
  assert.notEqual(checks.get("penalty.daily_rate_excessive").status, "conflict");
});
