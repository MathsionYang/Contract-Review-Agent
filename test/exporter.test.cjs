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

test("通过门禁时三种格式各生成一个实际文件和独立记录", async () => {
  const outputDir = tempDir();
  const result = await exportReview({
    review: reviewFixture(),
    formats: ["PDF", "XLSX", "JSON"],
    outputDir
  });

  assert.equal(result.validation.canExport, true);
  assert.equal(result.records.length, 3);
  for (const record of result.records) {
    assert.equal(record.status, "completed");
    assert.equal(fs.existsSync(record.filePath), true);
    assert.ok(fs.statSync(record.filePath).size > 0);
  }
});

test("DOCX 已下架：请求 DOCX 会被门禁拦截，不生成任何文件", async () => {
  const outputDir = tempDir();
  const result = await exportReview({ review: reviewFixture(), formats: ["DOCX"], outputDir });
  assert.equal(result.validation.canExport, false);
  assert.ok(result.validation.blockingCodes.includes("UNSUPPORTED_EXPORT_FORMAT"));
  assert.equal(result.records.length, 0);
  assert.equal(fs.readdirSync(outputDir).length, 0, "被拦截时不应写出任何文件");
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

test("JSON 导出保存完整通用清单、专项统计和人工复核记录", async () => {
  const catalog = require("../electron/general-checklist-catalog.json");
  const { coverageFrom } = require("../electron/checklist-policy.cjs");
  const review = reviewFixture();
  review.checklist_version = catalog.version;
  review.checklist_results = catalog.items.map((entry) => ({ ...entry, status: "pass" }));
  review.checklist_coverage = coverageFrom(review.checklist_results);
  review.check_results = [{ check_id: "test.check", status: "pass" }];
  review.coverage = coverageFrom(review.check_results);
  review.checklist_results[0].human_review = { reviewer: "测试法务", evidence: "测试材料" };
  const result = await exportReview({ review, formats: ["JSON"], outputDir: tempDir() });
  assert.equal(result.validation.canExport, true);
  const data = JSON.parse(fs.readFileSync(result.records[0].filePath, "utf8"));
  assert.equal(data.checklist_results.length, 95);
  assert.deepEqual(data.checklist_results, review.checklist_results);
  assert.deepEqual(data.checklist_coverage, review.checklist_coverage);
  assert.deepEqual(data.coverage, review.coverage);
});

test("三种草稿文件携带明确标记，且不再输出门禁明细", async (t) => {
  const review = reviewFixture();
  review.risks[0].human_status = "pending_review";
  review.risks[0].evidence_status = "unverified";
  review.risks[0].analysis = "本项尚需核对合同原件、补充材料和业务立场。".repeat(100);
  const before = JSON.stringify(review);
  const result = await exportReview({ review, mode: "draft", formats: ["PDF", "XLSX", "JSON"], outputDir: tempDir() });
  assert.equal(result.validation.canExport, true);
  assert.equal(result.records.length, 3);
  assert.equal(JSON.stringify(review), before);
  for (const record of result.records) {
    assert.equal(record.export_mode, "draft");
    assert.equal(record.report_status, "draft");
    assert.equal(record.formal_ready, false);
    assert.ok(record.filePath.includes("_草稿_"));
    assert.ok(record.warning_codes.includes("PENDING_HUMAN_REVIEW"));
  }
  const fileFor = (format) => result.records.find((record) => record.format === format).filePath;
  const json = JSON.parse(fs.readFileSync(fileFor("JSON"), "utf8"));
  assert.equal(json.export_mode, "draft");
  assert.deepEqual(json.risks, review.risks);
  // JSON 只保留校验结论，不再内嵌逐项门禁明细
  assert.equal(json.validation, undefined, "JSON 不应再内嵌门禁逐项明细");
  assert.equal(json.validation_summary.can_export, true);
  assert.equal(json.validation_summary.formal_ready, false);
  assert.ok(json.validation_summary.warning_codes.includes("PENDING_HUMAN_REVIEW"));
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fileFor("XLSX"));
  assert.ok(workbook.getWorksheet("审查风险清单").getCell("A1").value.includes("DRAFT / NOT FINAL"));
  // 门禁明细页已移除，改为只陈述报告状态的说明页
  assert.equal(workbook.getWorksheet("导出校验"), undefined, "不应再生成门禁明细页");
  const notes = workbook.getWorksheet("报告说明");
  assert.ok(notes.getCell("A1").value.includes("不得作为正式审查结论"));
  assert.equal(notes.getSheetValues().flat().includes("PENDING_HUMAN_REVIEW"), false, "说明页不应出现内部校验代码");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(fs.readFileSync(fileFor("PDF"))), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    assert.ok(document.numPages > 1);
    let text = "";
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join("");
      assert.ok(pageText.includes("DRAFT - NOT FINAL"), `page ${pageNumber}`);
      for (const item of content.items) {
        assert.ok(item.transform[4] >= 40 && item.transform[4] + item.width <= 555, `page ${pageNumber}: text outside margins`);
      }
      text += pageText;
    }
    // 报告只保留"草稿"结论性标记，不再平铺门禁明细
    assert.ok(text.includes("DRAFT - NOT FINAL"));
    assert.equal(text.includes("PENDING_HUMAN_REVIEW"), false, "PDF 不应出现内部校验代码");
    assert.equal(text.includes("待核验事项"), false, "PDF 不应再输出门禁明细章节");
  } finally {
    await loadingTask.destroy();
  }
  t.diagnostic(`draft artifacts: ${path.dirname(fileFor("PDF"))}`);
});

test("导出器直接调用也不能用草稿绕过硬阻断，不能自动升级草稿", async () => {
  const outputDir = tempDir();
  const review = reviewFixture();
  review.risks[0].title = `sk-${"s".repeat(30)}`;
  const blocked = await exportReview({ review, formats: ["JSON"], mode: "draft", outputDir });
  assert.equal(blocked.validation.canExport, false);
  assert.equal(blocked.records.length, 0);
  assert.equal(fs.readdirSync(outputDir).length, 0);
  const validDraft = await exportReview({ review: reviewFixture(), formats: ["JSON"], mode: "draft", outputDir });
  assert.equal(validDraft.records[0].report_status, "draft");
  assert.equal(validDraft.records[0].formal_ready, true);
  const formal = await exportReview({ review: reviewFixture(), formats: ["JSON"], mode: "formal", outputDir });
  assert.equal(formal.records[0].report_status, "formal");
  assert.deepEqual(formal.records[0].warning_codes, []);
  assert.ok(formal.records[0].filePath.includes("_正式_"));
});
