const test = require("node:test");
const assert = require("node:assert/strict");

const { validateReview } = require("../electron/validator.cjs");
const { coverageFrom } = require("../electron/review-runner.cjs");
const catalog = require("../electron/general-checklist-catalog.json");

function baseReview() {
  return {
    project: {
      project_id: "project-1",
      file_version_id: "contract_v1",
      contract_type: "procurement"
    },
    document: {
      text: "甲方与乙方签订采购合同。",
      pageCount: 1,
      sha256: "a".repeat(64)
    },
    risks: [{
      risk_id: "risk-1",
      risk_level: "high",
      title: "责任范围过宽",
      conclusion_status: "confirmed",
      evidence_status: "verified",
      human_status: "accepted",
      location_confidence: 0.96,
      contract_location: {
        file_version_id: "contract_v1",
        page: 1,
        clause_no: "7.2",
        char_range: [0, 8],
        quote: "责任范围过宽"
      }
    }],
    config: {
      snapshot: {
        id: "CN-2026-09",
        status: "published"
      },
      rules: ["contract-common@1.0"],
      policies: ["公司采购管理制度_v3.2.pdf"]
    }
  };
}

test("高风险仍待人工复核时阻断导出", () => {
  const review = baseReview();
  review.risks[0].human_status = "pending_review";

  const result = validateReview(review, { formats: ["JSON"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("PENDING_HUMAN_REVIEW"));
});

test("已接受且证据完整的高风险可以通过导出门禁", () => {
  const result = validateReview(baseReview(), { formats: ["JSON"] });

  assert.equal(result.canExport, true);
  assert.deepEqual(result.blockingCodes, []);
  assert.ok(result.items.every((item) => item.status === "passed"));
});

test("风险校验保留 decision_confidence 与 canonical_issue_id 字段", () => {
  const review = baseReview();
  review.risks[0].decision_confidence = "high";
  review.risks[0].canonical_issue_id = "liability_scope";
  const result = validateReview(review, { formats: ["JSON"] });
  assert.equal(result.canExport, true);
  assert.ok(!result.blockingCodes.includes("INVALID_DECISION_CONFIDENCE"));
});

test("非法 decision_confidence 阻断导出", () => {
  const review = baseReview();
  review.risks[0].decision_confidence = "certain";
  const result = validateReview(review, { formats: ["JSON"] });
  assert.ok(result.blockingCodes.includes("INVALID_DECISION_CONFIDENCE"));
});

test("扫描 PDF 没有 OCR 结果时标记为不可验证并阻断导出", () => {
  const review = baseReview();
  review.document.documentType = "scanned_pdf";
  review.document.text = "";
  review.document.pages = [{ page: 1, text: "", ocr: { status: "unavailable" } }];

  const result = validateReview(review, { formats: ["PDF"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("DOCUMENT_TEXT_UNAVAILABLE"));
});

test("结构化检查存在时覆盖率元数据必须完整且与检查数量一致", () => {
  const review = baseReview();
  review.check_results = [{ check_id: "amount.total", status: "pass", severity: "critical" }];
  review.coverage = { total: 2, executed: 1, passed: 1, conflict: 0, missing: 0, unverifiable: 0, not_applicable: 0, skipped: 0 };

  const result = validateReview(review, { formats: ["JSON"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("COVERAGE_INVALID"));
});

test("不适用检查不计入已执行数量且不会误阻断导出", () => {
  const review = baseReview();
  review.check_results = [
    { check_id: "amount.total", status: "pass", severity: "critical" },
    { check_id: "guarantee.term", status: "not_applicable", severity: "high" }
  ];
  review.coverage = coverageFrom(review.check_results);

  assert.equal(review.coverage.executed, 1);
  assert.equal(review.coverage.not_applicable, 1);
  assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, true);

  review.coverage.executed = 2;
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("COVERAGE_INVALID"));
});

test("关键结构化检查被跳过时阻断导出", () => {
  const review = baseReview();
  review.check_results = [{ check_id: "amount.total", status: "skipped", severity: "critical" }];
  review.coverage = { total: 1, executed: 0, passed: 0, conflict: 0, missing: 0, unverifiable: 0, not_applicable: 0, skipped: 1 };

  const result = validateReview(review, { formats: ["JSON"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("CRITICAL_CHECK_SKIPPED"));
});

test("高风险引用未解析时使用专用阻断码", () => {
  const review = baseReview();
  review.risks[0].contract_location = {
    file_version_id: "contract_v1",
    page: null,
    clause_no: "7.2",
    quote: "",
    location_status: "unresolved"
  };
  review.risks[0].location_confidence = 0;

  const result = validateReview(review, { formats: ["JSON"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("HIGH_RISK_LOCATION_UNRESOLVED"));
});

function withChecklist() {
  const review = baseReview();
  review.checklist_version = catalog.version;
  review.checklist_results = catalog.items.map((item) => ({ ...item, status: "pass" }));
  review.checklist_coverage = coverageFrom(review.checklist_results);
  return review;
}

test("通用清单不能缺项、重号、篡改等级、伪造状态或覆盖率", () => {
  for (const mutate of [
    (r) => { r.checklist_results.pop(); },
    (r) => { r.checklist_results[1].check_id = r.checklist_results[0].check_id; },
    (r) => { r.checklist_results[0].severity = "low"; },
    (r) => { r.checklist_results[0].status = "unknown"; },
    (r) => { r.checklist_version = "unknown"; },
    (r) => { delete r.checklist_results; }
  ]) {
    const review = withChecklist();
    mutate(review);
    assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("CHECKLIST_INVALID"));
  }
  const review = withChecklist();
  review.checklist_coverage.executed = 0;
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("CHECKLIST_COVERAGE_INVALID"));
});

test("高风险待核验项即使没有风险候选也不能静默通过导出", () => {
  const review = withChecklist();
  review.risks = [];
  const item = review.checklist_results.find((c) => c.check_id === "GC-1-05");
  item.status = "unverifiable";
  review.checklist_coverage = coverageFrom(review.checklist_results);
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("CHECKLIST_REVIEW_REQUIRED"));
  item.human_review = { outcome: "pass", reviewer: "测试复核人", note: "核验授权范围与有效期", evidence: "授权委托书 A-01", file_version_id: review.project.file_version_id, document_hash: review.document.sha256, catalog_version: catalog.version, reviewed_at: new Date().toISOString() };
  assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, true);
  item.human_review.file_version_id = "old-version";
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("CHECKLIST_REVIEW_REQUIRED"));
});

test("显式待定位不能因填入页码与文字绕过校验，真实 DOCX 块锚点可通过", () => {
  const review = baseReview();
  review.risks[0].contract_location.location_status = "unresolved";
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("HIGH_RISK_LOCATION_UNRESOLVED"));
  const { resolveRefs } = require("../electron/contract-evidence.cjs");
  review.document.documentType = "docx";
  review.document.blocks = [{ block_id: "b1", page: null, text: review.document.text }];
  const refs = resolveRefs(review.document, "甲方与乙方");
  review.risks[0].contract_location = { ...refs[0], file_version_id: review.project.file_version_id, location_status: "resolved", source_refs: refs };
  assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, true);
  review.document.blocks[0].text = "已修改的文本";
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("LOCATION_INVALID"));
});

test("草稿允许未完成、待复核、未定位和证据不足，正式报告保持阻断且不改变风险", () => {
  const review = withChecklist();
  review.task = { status: "partial" };
  review.config.snapshot.status = "draft";
  review.risks[0].human_status = "pending_review";
  review.risks[0].evidence_status = "unverified";
  review.risks[0].contract_location.location_status = "unresolved";
  review.checklist_results.find((check) => check.check_id === "GC-1-05").status = "unverifiable";
  review.checklist_coverage = coverageFrom(review.checklist_results);
  const before = JSON.stringify(review);
  const draft = validateReview(review, { formats: ["JSON"], mode: "draft" });
  assert.equal(draft.canExport, true);
  assert.equal(draft.formalReady, false);
  assert.deepEqual(draft.blockingCodes, []);
  for (const code of ["REVIEW_INCOMPLETE", "SNAPSHOT_NOT_FOUND", "PENDING_HUMAN_REVIEW", "EVIDENCE_INCOMPLETE", "HIGH_RISK_LOCATION_UNRESOLVED", "CHECKLIST_REVIEW_REQUIRED"]) {
    assert.ok(draft.warningCodes.includes(code), code);
  }
  assert.ok(draft.items.filter((item) => item.code).every((item) => item.status === "warning"));
  const formal = validateReview(review, { formats: ["JSON"], mode: "formal" });
  assert.equal(formal.canExport, false);
  assert.deepEqual(formal.blockingCodes, draft.formalBlockingCodes);
  assert.equal(JSON.stringify(review), before);
});

test("草稿不放开密钥、结构错误、文件版本错误和运行中的任务", () => {
  for (const [code, mutate] of [
    ["SENSITIVE_DATA_DETECTED", (review) => { review.note = `sk-${"a".repeat(28)}`; }],
    ["REQUIRED_FIELD_MISSING", (review) => { delete review.risks[0].title; }],
    ["PROJECT_MISSING", (review) => { delete review.project; }],
    ["DOCUMENT_MISSING", (review) => { delete review.document; }],
    ["RISKS_INVALID", (review) => { review.risks = {}; }],
    ["FILE_VERSION_MISSING", (review) => { delete review.project.file_version_id; }],
    ["LOCATION_VERSION_MISMATCH", (review) => { review.risks[0].contract_location.file_version_id = "old-version"; }],
    ["CHECKLIST_INVALID", (review) => { review.checklist_results.pop(); }],
    ["CHECKLIST_COVERAGE_INVALID", (review) => { review.checklist_coverage.executed = 0; }],
    ["EXPORT_TASK_RUNNING", (review) => { review.task = { status: "running" }; }]
  ]) {
    const review = withChecklist();
    mutate(review);
    const result = validateReview(review, { formats: ["JSON"], mode: "draft" });
    assert.equal(result.canExport, false, code);
    assert.ok(result.blockingCodes.includes(code), code);
    assert.ok(!result.warningCodes.includes(code), code);
  }
  for (const mode of [null, "", "force", "DRAFT"]) {
    assert.ok(validateReview(baseReview(), { formats: ["JSON"], mode }).blockingCodes.includes("INVALID_EXPORT_MODE"));
  }
  assert.ok(validateReview(baseReview(), { formats: ["ZIP"], mode: "draft" }).blockingCodes.includes("UNSUPPORTED_EXPORT_FORMAT"));
  assert.ok(validateReview(baseReview(), { formats: [], mode: "draft" }).blockingCodes.includes("NO_EXPORT_FORMAT"));
});

test("草稿可说明缺失项或扫描件无法核验，不能伪造原文或变成正式报告", () => {
  const review = baseReview();
  review.document.documentType = "scanned_pdf";
  review.document.text = "";
  review.document.ocr = { status: "unavailable" };
  review.risks[0].risk_topic = "missing_clause";
  review.risks[0].contract_location = { file_version_id: "contract_v1", page: null, quote: "", location_status: "unresolved" };
  const result = validateReview(review, { formats: ["PDF"], mode: "draft" });
  assert.equal(result.canExport, true);
  assert.ok(result.warningCodes.includes("DOCUMENT_TEXT_UNAVAILABLE"));
  assert.equal(result.formalReady, false);
  assert.equal(review.risks[0].contract_location.quote, "");
});

test("历史 DOCX 引用只在哈希一致且块内唯一时兼容缺少字符范围", () => {
  const crypto = require("node:crypto");
  const review = baseReview();
  review.document.documentType = "docx";
  review.document.blocks = [{ block_id: "b1", page: null, text: "真实的责任范围过宽条款。" }];
  const ref = { block_id: "b1", quote: "责任范围过宽", text_hash: `sha256:${crypto.createHash("sha256").update(review.document.blocks[0].text).digest("hex")}` };
  review.risks[0].contract_location = { file_version_id: "contract_v1", page: null, quote: ref.quote, source_refs: [ref], location_status: "resolved" };
  assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, true);
  ref.char_range = [0, 2];
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("LOCATION_INVALID"));
  delete ref.char_range;
  review.document.blocks[0].text = "责任范围过宽，责任范围过宽。";
  ref.text_hash = `sha256:${crypto.createHash("sha256").update(review.document.blocks[0].text).digest("hex")}`;
  assert.ok(validateReview(review, { formats: ["JSON"] }).blockingCodes.includes("LOCATION_INVALID"));
});

test("已删除或判定误报并驳回的风险不继续阻断正式报告", () => {
  for (const humanStatus of ["deleted", "false_positive"]) {
    const review = baseReview();
    Object.assign(review.risks[0], { human_status: humanStatus, conclusion_status: "rejected", evidence_status: "unverified", contract_location: null });
    assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, true);
    review.risks[0].conclusion_status = "confirmed";
    assert.equal(validateReview(review, { formats: ["JSON"] }).canExport, false);
  }
});

test("被用户停止的审查即使证据完整也不能导出，草稿模式也不放行", () => {
  const review = baseReview();
  review.task = { status: "cancelled", errors: [{ code: "REVIEW_CANCELLED", stage: "model" }] };
  const formal = validateReview(review, { formats: ["JSON"] });
  assert.equal(formal.canExport, false);
  assert.ok(formal.blockingCodes.includes("REVIEW_CANCELLED"));
  // 取消是硬阻断：草稿模式同样不得把已停止的审查当作可交付结果。
  const draft = validateReview(review, { formats: ["JSON"], mode: "draft" });
  assert.equal(draft.canExport, false);
  assert.ok(draft.blockingCodes.includes("REVIEW_CANCELLED"));
});

test("取消不改变既有风险门禁，未复核的高风险仍独立阻断正式报告", () => {
  const review = baseReview();
  review.risks[0].human_status = "pending_review";
  const formal = validateReview(review, { formats: ["JSON"] });
  assert.ok(formal.blockingCodes.includes("PENDING_HUMAN_REVIEW"));
  review.task = { status: "cancelled" };
  const cancelled = validateReview(review, { formats: ["JSON"] });
  assert.ok(cancelled.blockingCodes.includes("REVIEW_CANCELLED"));
  assert.ok(cancelled.blockingCodes.includes("PENDING_HUMAN_REVIEW"));
});
