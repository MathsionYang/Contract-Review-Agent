const test = require("node:test");
const assert = require("node:assert/strict");

const { validateReview } = require("../electron/validator.cjs");

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

test("扫描 PDF 没有 OCR 结果时标记为不可验证并阻断导出", () => {
  const review = baseReview();
  review.document.documentType = "scanned_pdf";
  review.document.text = "";
  review.document.pages = [{ page: 1, text: "", ocr: { status: "unavailable" } }];

  const result = validateReview(review, { formats: ["PDF"] });

  assert.equal(result.canExport, false);
  assert.ok(result.blockingCodes.includes("DOCUMENT_TEXT_UNAVAILABLE"));
});
