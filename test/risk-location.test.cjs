const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeModelRisks, mergeReviewFindings } = require("../electron/review-engine.cjs");

const text = "2.1 预付款为合同金额的\n 50%，签约后支付。";
const document = { documentType: "docx", fileVersionId: "v1", text,
  pages: [{ page: 1, text }], blocks: [{ block_id: "b1", page: null, logical_page: 1, text }] };

test("模型未引用原文不得用合同首页填充定位", () => {
  const [risk] = normalizeModelRisks({ risks: [{ title: "预付款风险", contract_location: { page: 1, clause_no: "2.1" } }] }, { document });
  assert.equal(risk.contract_location.page, null);
  assert.equal(risk.contract_location.quote, "");
  assert.equal(risk.contract_location.location_status, "unresolved");
});

test("空白差异可回溯原始文本与块内范围，DOCX 不伪造物理页码或信任模型条号", () => {
  const [risk] = normalizeModelRisks({ risks: [{ title: "预付款风险", quote: "预付款为合同金额的50%", contract_location: { clause_no: "9.9", page: 8 } }] }, { document });
  const location = risk.contract_location;
  assert.equal(location.page, null);
  assert.equal(location.clause_no, "2.1");
  assert.equal(location.location_status, "resolved");
  assert.equal(location.block_id, "b1");
  assert.equal(location.quote, "预付款为合同金额的\n 50%");
  assert.equal(text.slice(...location.char_range), location.quote);
});

test("重复短引用保持歧义，同名不同条款风险不能合并", () => {
  const [risk] = normalizeModelRisks({ risks: [{ title: "付款", quote: "付款" }] }, { document: {
    pages: [{ page: 1, text: "付款" }, { page: 2, text: "付款" }]
  } });
  assert.equal(risk.contract_location.location_status, "unresolved");
  const risks = mergeReviewFindings(["2.1", "3.1"].map((clause_no) => ({ title: "付款风险", contract_location: { page: 1, clause_no, quote: clause_no } })));
  assert.equal(risks.length, 2);
});

test("匹配合同引文不等于模型法律结论已核验", () => {
  const [risk] = normalizeModelRisks({ risks: [{ title: "预付款条款违法", quote: "预付款为合同金额的50%", conclusion_status: "confirmed", evidence_status: "verified" }] }, { document });
  assert.equal(risk.contract_location.location_status, "resolved");
  assert.equal(risk.conclusion_status, "needs_verification");
  assert.equal(risk.evidence_status, "unverified");
});
