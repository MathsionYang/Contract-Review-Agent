const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { exportReview } = require("../electron/exporter.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "export-chart-"));
}

// DOCX / XLSX 都是 OOXML（zip），必须先解压再断言内容，否则读到的只是压缩字节。
function readZipEntry(filePath, entryName) {
  const buffer = fs.readFileSync(filePath);
  let offset = 0;
  while ((offset = buffer.indexOf(Buffer.from("PK\x03\x04", "latin1"), offset)) >= 0) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    if (name === entryName) {
      const data = buffer.slice(dataStart, dataStart + compressedSize);
      return method === 0 ? data.toString("utf8") : zlib.inflateRawSync(data).toString("utf8");
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

function zipEntryNames(filePath) {
  const buffer = fs.readFileSync(filePath);
  const names = [];
  let offset = 0;
  while ((offset = buffer.indexOf(Buffer.from("PK\x03\x04", "latin1"), offset)) >= 0) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.slice(offset + 30, offset + 30 + nameLength).toString("utf8"));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

function riskFixture(id, level, clause, humanStatus, confidence) {
  return {
    risk_id: id, risk_level: level, title: `风险 ${id}`, analysis: "分析内容", suggestion: "修改建议",
    conclusion_status: "confirmed", evidence_status: "verified", human_status: humanStatus,
    location_confidence: confidence,
    contract_location: { file_version_id: "contract_v1", page: 1, clause_no: clause, char_range: [0, 4], quote: "原文片段" }
  };
}

function reviewFixture() {
  return {
    project: { project_id: "p1", project_name: "采购合同", file_version_id: "contract_v1", contract_type: "procurement" },
    document: { fileName: "采购合同.docx", text: "甲方与乙方签订采购合同。", pageCount: 1, sha256: "a".repeat(64),
      pages: [{ page: 1, text: "甲方与乙方签订采购合同。" }] },
    // 故意乱序，且包含一条待复核的 low 用来验证"等级优先于人工状态"
    risks: [
      riskFixture("r-low", "low", "3.1", "pending_review", 0.9),
      riskFixture("r-high", "high", "8.1", "pending_review", 0.8),
      riskFixture("r-critical", "critical", "2.3", "pending_review", 0.7),
      riskFixture("r-medium", "medium", "5.2", "accepted", 0.95),
      riskFixture("r-high2", "high", "2.1", "accepted", 0.6),
      { ...riskFixture("r-deleted", "critical", "9.9", "deleted", 0.5) }
    ],
    config: { snapshot: { id: "CN-2026-09", status: "published" }, rules: ["r1"], policies: ["p1"] },
    humanRevisions: []
  };
}

async function exportAll() {
  const outputDir = tempDir();
  const result = await exportReview({ review: reviewFixture(), formats: ["PDF", "XLSX", "JSON"], outputDir, mode: "draft" });
  const byFormat = Object.fromEntries(result.records.map((record) => [record.format, record.filePath]));
  return { outputDir, byFormat };
}

test("风险按等级从严重到轻排序，同级按待复核优先，已删除不导出", async () => {
  const { byFormat } = await exportAll();
  const payload = JSON.parse(fs.readFileSync(byFormat.JSON, "utf8"));
  assert.deepEqual(payload.risks.map((risk) => risk.risk_id), ["r-critical", "r-high", "r-high2", "r-medium", "r-low"]);
  assert.equal(payload.risks.some((risk) => risk.risk_id === "r-deleted"), false, "已删除风险不得导出");
  // 同级内：待复核(human/pending) 必须排在已接受之前
  const highs = payload.risks.filter((risk) => risk.risk_level === "high").map((risk) => risk.human_status);
  assert.deepEqual(highs, ["pending_review", "accepted"]);
  // 顺序规则与图表数据需要可被消费方直接读取
  assert.ok(payload.risk_order.includes("risk_level desc"));
  assert.deepEqual(payload.severity_distribution.map((item) => `${item.level}:${item.count}`),
    ["critical:1", "high:2", "medium:1", "low:1", "info:0"]);
  assert.equal(payload.level_meta.length, 5);
  assert.ok(payload.level_meta.every((item) => item.label && item.color));
});

test("导出保留风险等级、结论置信度和 canonical 风险组", async () => {
  const review = reviewFixture();
  review.risks[0].decision_confidence = "medium";
  review.risks[0].canonical_issue_id = "amount_consistency";
  const outputDir = tempDir();
  const result = await exportReview({ review, formats: ["JSON", "XLSX", "PDF"], outputDir, mode: "draft" });
  const jsonPath = result.records.find((record) => record.format === "JSON").filePath;
  const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const risk = payload.risks.find((item) => item.risk_id === "r-low");
  assert.equal(risk.decision_confidence, "medium");
  assert.equal(risk.canonical_issue_id, "amount_consistency");
  assert.ok(payload.risk_field_contract.includes("decision_confidence"));
  const xlsxPath = result.records.find((record) => record.format === "XLSX").filePath;
  const sharedStrings = readZipEntry(xlsxPath, "xl/sharedStrings.xml");
  assert.ok(sharedStrings.includes("结论置信度"));
  assert.ok(sharedStrings.includes("风险聚合组"));
});

test("DOCX 已从导出格式下架，请求时被门禁拦截", async () => {
  const outputDir = tempDir();
  const result = await exportReview({ review: reviewFixture(), formats: ["DOCX"], outputDir, mode: "draft" });
  assert.equal(result.validation.canExport, false, "DOCX 不再作为可导出格式");
  assert.ok(result.validation.blockingCodes.includes("UNSUPPORTED_EXPORT_FORMAT"));
  assert.equal(result.records.length, 0);
  assert.deepEqual(fs.readdirSync(outputDir), [], "被拦截时不得写出任何文件");
  // 其余三种格式仍然可用
  const allowed = await exportReview({ review: reviewFixture(), formats: ["PDF", "XLSX", "JSON"], outputDir, mode: "draft" });
  assert.equal(allowed.validation.canExport, true);
  assert.deepEqual(allowed.records.map((record) => record.format).sort(), ["JSON", "PDF", "XLSX"]);
});

test("XLSX 包含风险分布表与数据条条件格式", async () => {
  const { byFormat } = await exportAll();
  const workbook = readZipEntry(byFormat.XLSX, "xl/workbook.xml");
  assert.ok(workbook.includes("审查风险清单"));
  assert.ok(workbook.includes("风险分布"));
  // 门禁明细页已移除，取而代之的是只陈述报告状态的说明页
  assert.equal(workbook.includes("导出校验"), false, "不应再生成门禁明细页");
  assert.ok(workbook.includes("报告说明"));
  // ExcelJS 4.4 没有图表 API，可视化必须靠数据条条件格式实现，且必须真的写进文件
  const sheet = readZipEntry(byFormat.XLSX, "xl/worksheets/sheet2.xml");
  assert.ok(sheet, "风险分布表必须存在");
  assert.ok(sheet.includes("dataBar"), "风险分布表必须写入数据条规则");
  assert.ok((sheet.match(/<conditionalFormatting/g) || []).length >= 5, "每个等级一行都应有一条数据条规则");
});

test("PDF 报告可生成且大小随风险数量增长", async () => {
  const { byFormat } = await exportAll();
  const pdf = fs.readFileSync(byFormat.PDF);
  assert.equal(pdf.slice(0, 5).toString(), "%PDF-", "必须是合法 PDF 文件头");
  assert.ok(pdf.length > 3000, "PDF 不应为空壳");
  // pdf-lib 会把对象流压缩，无法直接搜 /Page；用"风险更多则文件更大"验证内容确实写入了。
  const richer = { ...reviewFixture(),
    risks: [...reviewFixture().risks, ...Array.from({ length: 12 }, (_, index) => riskFixture(`r-extra-${index}`, "medium", `7.${index}`, "pending_review", 0.5))] };
  const dir = tempDir();
  const bigger = await exportReview({ review: richer, formats: ["PDF"], outputDir: dir, mode: "draft" });
  assert.ok(fs.statSync(bigger.records[0].filePath).size > pdf.length, "风险更多时 PDF 应当更大");
});
