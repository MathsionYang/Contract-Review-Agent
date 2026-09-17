const test = require("node:test");
const assert = require("node:assert/strict");

const { extractContractFacts, parseChineseMoney } = require("../electron/contract-facts.cjs");

const fixture = {
  fileVersionId: "contract_v1",
  text: [
    "甲方：瀚元智能装备制造有限公司，地址：湖南省长沙市岳麓区。乙方：云枢软件技术（武汉）有限公司，地址：湖北省武汉市东湖新技术开发区。",
    "2.1 本合同总价款为人民币壹佰贰拾捌万陆仟元整（小写：¥1,268,000 元）。",
    "2.2 明细合计 1,286,000 元。",
    "2.3 甲方向乙方支付合同总价款的 50%，即人民币 634,000 元；支付 40%，即人民币 507,200 元；支付 15%，即人民币 190,200 元。",
    "3.3 甲方应向甲方提供软件安装介质。",
    "4.2 甲方应在 10 个工作日内组织测试验收。",
    "4.3 初验合格后进入 30 个自然日试运行期。",
    "8.1 每逾期一日按合同总价款的万分之五支付违约金。",
    "8.3 除按第 8.1 条支付违约金外，另按合同总价款的 10% 支付违约金。",
    "8.4 乙方向乙方支付违约金人民币 200,000 元。",
    "8.5 包括直接损失、间接损失、可得利益损失及第三方索赔。",
    "10.2 向乙方所在地人民法院提起诉讼。",
    "11.1 许可期限为永久，合同有效期三年。",
    "11.4 交付后 15 个自然日内完成验收。"
  ].join("\n"),
  pages: [{ page: 1, text: "合同正文" }]
};

test("中文大写金额可以转换为定点整数", () => {
  assert.equal(parseChineseMoney("壹佰贰拾捌万陆仟"), "1286000");
  assert.equal(parseChineseMoney("壹佰贰拾捌万陆仟元整"), "1286000");
});

test("合同事实抽取保留金额比例期限主体和责任原文", () => {
  const result = extractContractFacts(fixture, { contractType: "procurement" });

  assert.ok(result.facts.some((fact) => fact.fact_type === "money" && fact.value === "1286000" && fact.clause_no === "2.1"));
  assert.ok(result.facts.some((fact) => fact.fact_type === "money" && fact.value === "1268000" && fact.clause_no === "2.1"));
  assert.equal(result.facts.filter((fact) => fact.fact_type === "ratio" && fact.clause_no === "2.3").map((fact) => fact.value).join(","), "0.5,0.4,0.15");
  assert.ok(result.facts.some((fact) => fact.fact_type === "duration" && fact.value === 10 && fact.calendar_type === "workday"));
  assert.ok(result.facts.some((fact) => fact.fact_type === "duration" && fact.value === 30 && fact.calendar_type === "calendar_day"));
  assert.ok(result.facts.some((fact) => fact.fact_type === "obligation" && fact.subject === "甲方" && fact.object_party === "甲方"));
  assert.ok(result.facts.some((fact) => fact.fact_type === "penalty" && fact.rate_basis === "万分之五"));
  assert.ok(result.facts.some((fact) => fact.fact_type === "party" && fact.party_id === "甲方" && /长沙/.test(fact.address)));
  assert.ok(result.clauses.some((clause) => clause.clause_no === "8.5" && /间接损失/.test(clause.text)));
  assert.ok(result.facts.every((fact) => Array.isArray(fact.source_refs) && fact.source_refs.length > 0));
});

test("直接向某方支付的主宾均抽取，引用编号不覆盖当前条款编号", () => {
  const result = extractContractFacts(fixture);
  assert.ok(result.facts.some((f) => f.fact_type === "obligation" && f.clause_no === "8.4" && f.subject === "乙方" && f.object_party === "乙方"));
  assert.ok(result.facts.some((f) => f.fact_type === "ratio" && f.value === 0.1 && f.clause_no === "8.3"));
});

test("同页违约条款前的空格不会将事实归入上一条款", () => {
  const text = "7.2 保密义务。 第八条 违约责任与赔偿条款 8.1 乙方按万分之五支付违约金。  8.2 甲方按万分之一支付违约金。  8.3 除按第 8.1 条支付违约金外，另按 10% 支付违约金。";
  const result = extractContractFacts({ text, pages: [{ page: 1, text }] });
  const penalties = result.facts.filter((f) => f.fact_type === "penalty");
  assert.deepEqual(penalties.map((f) => [f.clause_no, f.rate_basis]), [
    ["8.1", "万分之五"], ["8.2", "万分之一"], ["8.3", "10%"]
  ]);
  assert.deepEqual(penalties[2].references, ["8.1"]);
});

test("跨字段地址候选保留警告与低置信度，单独地址不受影响", () => {
  const text = "注册地址 湖南省长沙市示例路1号 湖北省武汉市示例路2号 联系方式 李某 123456";
  const result = extractContractFacts({ text, pages: [{ page: 1, text }] });
  const address = result.facts.find((f) => f.fact_type === "party");
  assert.ok(address.confidence < 0.7);
  const warning = result.warnings.find((w) => w.code === "PARTY_ADDRESS_SEGMENTATION_UNCERTAIN");
  assert.equal(warning.fact_id, address.fact_id);
  assert.ok(warning.source_refs.some((ref) => ref.block_id === "page_1"));

  const separate = extractContractFacts(fixture);
  assert.ok(!separate.warnings.some((w) => w.code === "PARTY_ADDRESS_SEGMENTATION_UNCERTAIN"));
});
