const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { exportReview } = require("../electron/exporter.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-export-"));
}

function reviewFixture() {
  return {
    project: {
      project_id: "project-1",
      project_name: "采购合同",
      file_version_id: "contract_v1",
      contract_type: "procurement"
    },
    document: {
      fileName: "采购合同.docx",
      text: "甲方与乙方签订采购合同。",
      pageCount: 1,
      sha256: "a".repeat(64),
      pages: [{ page: 1, text: "甲方与乙方签订采购合同。" }]
    },
    risks: [{
      risk_id: "risk-1",
      risk_level: "high",
      title: "责任范围过宽",
      analysis: "需要限制责任范围。",
      suggestion: "建议增加合理责任上限。",
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
      snapshot: { id: "CN-2026-09", status: "published" },
      rules: ["contract-common@1.0"],
      policies: ["公司采购管理制度_v3.2.pdf"]
    },
    humanRevisions: []
  };
}

test("通过门禁时四种格式各生成一个实际文件和独立记录", async () => {
  const outputDir = tempDir();
  const result = await exportReview({
    review: reviewFixture(),
    formats: ["DOCX", "PDF", "XLSX", "JSON"],
    outputDir
  });

  assert.equal(result.validation.canExport, true);
  assert.equal(result.records.length, 4);
  for (const record of result.records) {
    assert.equal(record.status, "completed");
    assert.equal(fs.existsSync(record.filePath), true);
    assert.ok(fs.statSync(record.filePath).size > 0);
  }
});

test("门禁失败时不生成 completed 导出记录", async () => {
  const outputDir = tempDir();
  const review = reviewFixture();
  review.risks[0].human_status = "pending_review";

  const result = await exportReview({
    review,
    formats: ["JSON"],
    outputDir
  });

  assert.equal(result.validation.canExport, false);
  assert.equal(result.records.length, 0);
  assert.equal(fs.readdirSync(outputDir).length, 0);
});
