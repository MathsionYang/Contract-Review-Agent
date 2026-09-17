const test = require("node:test");
const assert = require("node:assert/strict");

test("人工清单复核保留自动状态、版本依据与历史，撤回也不覆盖旧记录", async () => {
  const { recordChecklistReview } = await import("../src/services/checklistReview.mjs");
  const review = { project: { file_version_id: "v1" }, document: { sha256: "hash" }, checklist_version: "gc1",
    checklist_results: [{ check_id: "GC-1-05", status: "unverifiable" }], review_version_id: "rv1", checklist_coverage: { total: 1 } };
  const input = { outcome: "pass", reviewer: "法务", note: "核对范围与期限", evidence: "授权书编号 A-1" };
  const next = recordChecklistReview(review, "GC-1-05", input);
  assert.equal(next.checklist_results[0].status, "unverifiable");
  assert.equal(next.checklist_results[0].human_review.file_version_id, "v1");
  assert.equal(next.checklist_results[0].human_review.document_hash, "hash");
  assert.equal(review.checklist_results[0].human_review, undefined);
  assert.deepEqual(next.checklist_coverage, review.checklist_coverage);
  const reset = recordChecklistReview(next, "GC-1-05", { ...input, outcome: "unverifiable" });
  assert.equal(reset.humanRevisions.length, 2);
  assert.equal(reset.humanRevisions[0].changes.previous.outcome, "pass");
  assert.throws(() => recordChecklistReview(review, "GC-1-05", { ...input, evidence: " " }), /材料依据/);
});

test("原文导航使用逻辑页而不伪造 DOCX 物理页码，空白差异仍可高亮", async () => {
  const { locationLabel, locationPage, quoteRange } = await import("../src/services/checklistReview.mjs");
  const location = { quote: "预付款50%", page: null, source_refs: [{ block_id: "b1", quote: "预付款50%", logical_page: 1 }] };
  assert.equal(locationLabel(location), "逻辑块定位");
  assert.equal(locationPage(location), 1);
  assert.equal(locationPage({ ...location, location_status: "unresolved" }), null);
  assert.deepEqual(quoteRange("2.1 预付款\n50%。", location.quote), [4, 11]);
});
