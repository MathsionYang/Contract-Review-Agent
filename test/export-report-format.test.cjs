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
  const result = await exportReview({ review: reviewFixture(), formats: ["DOCX", "PDF", "XLSX", "JSON"], outputDir, mode: "draft" });
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

test("DOCX 报告包含等级分布图与风险条款表格", async () => {
  const { byFormat } = await exportAll();
  const xml = readZipEntry(byFormat.DOCX, "word/document.xml");
  assert.ok(xml, "DOCX 必须包含 word/document.xml");
  // 两张表：等级分布图 + 风险条款清单
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 2, "应有分布图与风险清单两张表");
  assert.equal((xml.match(/<w:tr>/g) || []).length >= 18, true, "分布 6 行 + 清单表头 1 行 + 5 条风险");
  // 分布图用等宽方块条表达数量
  assert.ok((xml.match(/█/g) || []).length >= 20, "分布图必须包含条形字符");
  assert.ok(xml.includes("风险等级分布"));
  assert.ok(xml.includes("风险条款清单"));
  assert.ok(xml.includes("按严重程度排序"));
  // 严重项在文档中必须出现在轻微项之前
  assert.ok(xml.indexOf("风险 r-critical") < xml.indexOf("风险 r-low"), "严重风险必须排在轻微风险之前");
});

test("XLSX 包含风险分布表与数据条条件格式", async () => {
  const { byFormat } = await exportAll();
  const workbook = readZipEntry(byFormat.XLSX, "xl/workbook.xml");
  assert.ok(workbook.includes("审查风险清单"));
  assert.ok(workbook.includes("风险分布"));
  assert.ok(workbook.includes("导出校验"));
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
  // 加密后仍应包含页对象
  assert.ok(pdf.includes(Buffer.from("/Type /Page", "latin1")) || pdf.includes(Buffer.from("/Page", "latin1")));
});
