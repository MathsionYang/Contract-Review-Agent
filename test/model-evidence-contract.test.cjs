"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { modelMessages, validateModelRiskEvidence } = require("../electron/review-runner.cjs");

const document = {
  documentType: "docx",
  text: "1.1 交付应按期完成。",
  blocks: [{ block_id: "evidence_block_1", page: null, logical_page: 1, clause_no: "1.1", char_range: [0, 12], text: "1.1 交付应按期完成。", text_hash: "sha256:test" }],
  pages: [{ page: 1, text: "1.1 交付应按期完成。" }]
};

test("语义分析上下文包含可回放的 evidence_catalog", () => {
  const result = modelMessages({ document, project: { contract_type: "service" }, contract_facts: [], checklist_results: [] }, [], { contextLength: 6000, maxTokens: 256 });
  assert.ok(result.messages);
  const payload = JSON.parse(result.messages[1].content);
  assert.ok(Array.isArray(payload.evidence_catalog));
  assert.equal(payload.evidence_catalog[0].block_id, "evidence_block_1");
  assert.deepEqual(payload.evidence_catalog[0].char_range, [0, 12]);
  assert.equal(payload.evidence_catalog[0].clause_no, "1.1");
});

test("模型提供非法引文或越界范围时返回 MODEL_EVIDENCE_INVALID", () => {
  const invalid = validateModelRiskEvidence({ contract_location: {
    block_id: "evidence_block_1", clause_no: "1.1", quote: "合同中不存在", char_range: [0, 100]
  } }, document);
  assert.equal(invalid.code, "MODEL_EVIDENCE_INVALID");
  assert.equal(validateModelRiskEvidence({ title: "待核验风险" }, document), null);
});
