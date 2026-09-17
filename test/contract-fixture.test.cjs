const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { parseContract } = require("../electron/parser.cjs");
const { runReview } = require("../electron/review-runner.cjs");

async function reviewFixture(fileName) {
  const document = await parseContract(path.join(__dirname, "..", "data", fileName));
  document.fileVersionId = `fixture_${path.extname(fileName).slice(1)}`;
  const result = await runReview({
    review: {
      project: { project_id: `fixture-${fileName}`, file_version_id: document.fileVersionId, contract_type: "procurement" },
      document,
      config: { snapshot: { id: "", status: "draft" }, rules: [], policies: [] },
      task: { task_id: `task-${fileName}`, status: "queued", progress: 0 }
    },
    state: { knowledge: { legalSnapshots: [], rules: [], policies: [] }, capabilities: { models: [] }, settings: {} }
  });
  return result.review;
}

test("真实合同的 DOCX 与 PDF 均覆盖确定性关键风险并保留证据", async () => {
  const reviews = await Promise.all([
    reviewFixture("软件采购合同.docx"),
    reviewFixture("软件采购合同.pdf")
  ]);
  const criticalIds = [
    "amount.total_vs_uppercase",
    "amount.item_sum",
    "amount.schedule_ratio_sum",
    "party.obligation_subject_inversion",
    "penalty.stacking",
    "liability.broad_indirect_loss"
  ];
  const priorityIds = [...criticalIds, "amount.schedule_amount_anchor", "timeline.acceptance_deadline_conflict"];
  const requiredGroups = ["amount", "timeline", "party", "penalty", "completeness", "acceptance"];

  for (const field of ["check_results", "checklist_results"]) {
    const states = (review) => review[field].map((c) => [c.check_id, c.status]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(states(reviews[0]), states(reviews[1]), field);
  }
  assert.deepEqual(reviews[0].coverage, reviews[1].coverage);
  assert.deepEqual(reviews[0].checklist_coverage, reviews[1].checklist_coverage);

  for (const review of reviews) {
    const byId = new Map(review.check_results.map((check) => [check.check_id, check]));
    assert.ok(priorityIds.every((id) => byId.get(id)?.status === "conflict"));
    assert.ok(requiredGroups.every((group) => review.check_results.some((check) => check.check_id.startsWith(`${group}.`))));
    assert.ok(review.coverage.executed / review.coverage.total >= 0.8);
    assert.equal(review.coverage.skipped, 0);
    assert.equal(byId.get("amount.schedule_amount_anchor").status, "conflict");
    const inverted = review.contract_facts.filter((f) => f.fact_type === "obligation" && f.subject === f.object_party);
    assert.ok(inverted.some((f) => f.clause_no === "3.3"));
    assert.ok(inverted.some((f) => f.clause_no === "8.4"));
    const blocks = new Map(review.document.blocks.map((block) => [block.block_id, block]));
    for (const id of priorityIds) {
      const risk = review.risks.find((r) => r.rule_id === id);
      assert.ok(risk, id);
      assert.ok(risk.contract_location.source_refs.length > 0, id);
      for (const ref of risk.contract_location.source_refs) {
        assert.ok(ref.quote && blocks.get(ref.block_id)?.text.includes(ref.quote), id);
      }
    }
    for (const block of blocks.values()) {
      assert.ok(Array.isArray(block.char_range), block.block_id);
      assert.equal(review.document.text.slice(...block.char_range).replace(/\s+/g, " ").trim(), block.text, block.block_id);
    }
    for (const clauseNo of ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"]) {
      assert.ok(review.contract_facts.some((f) => f.fact_type === "penalty" && f.clause_no === clauseNo), clauseNo);
    }
    // 通用清单待核验属于审查结论而非流程故障：流程已跑完，状态为 completed，
    // 但仍以 CHECKLIST_REVIEW_REQUIRED 阻断正式导出（见下方 formalReady）。
    assert.equal(review.task.status, "completed");
    assert.ok(review.task.errors.some((error) => error.code === "CHECKLIST_REVIEW_REQUIRED" && error.check_ids.length > 0));
    const { validateReview } = require("../electron/validator.cjs");
    const draft = validateReview(review, { formats: ["PDF", "XLSX", "JSON"], mode: "draft" });
    assert.equal(draft.canExport, true, draft.blockingCodes.join(","));
    assert.equal(draft.formalReady, false);
    for (const id of priorityIds) {
      const risk = review.risks.find((r) => r.rule_id === id);
      assert.ok(!draft.items.some((item) => item.riskId === risk.risk_id && item.code === "HIGH_RISK_LOCATION_UNRESOLVED"), id);
    }
    assert.equal(validateReview(review, { formats: ["JSON"], mode: "formal" }).canExport, false);
  }
  assert.ok(reviews[0].fact_warnings.some((warning) => warning.code === "PAGE_LOCATION_UNRESOLVED"));
  assert.ok(reviews[0].document.blocks.filter((b) => b.text.includes("V3.0")).every((b) => b.clause_no !== "3.0"));
  assert.ok(reviews[1].fact_warnings.some((warning) => warning.code === "PARTY_ADDRESS_SEGMENTATION_UNCERTAIN"));
});

test("跨行文本不会造成 PDF 与 DOCX 的验收和保密缺失检查分歧", async () => {
  const reviews = await Promise.all([
    reviewFixture("软件采购合同.docx"),
    reviewFixture("软件采购合同.pdf")
  ]);

  for (const review of reviews) {
    const byId = new Map(review.check_results.map((check) => [check.check_id, check.status]));
    assert.equal(byId.get("acceptance.subjective_standard"), "conflict");
    assert.equal(byId.get("completeness.confidentiality_remedy"), "missing");
  }
});
