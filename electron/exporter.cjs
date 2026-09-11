const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Document, HeadingLevel, Paragraph, Packer, TextRun, Table, TableRow, TableCell, WidthType } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const ExcelJS = require("exceljs");
const { validateReview } = require("./validator.cjs");

const TEMPLATE_VERSION = "review-report@1.0.0";

function safeFileName(value) {
  return String(value || "合同审查")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "合同审查";
}

function exportId(format) {
  return `export_${format.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function outputPath(outputDir, stem, format, id) {
  const extension = format.toLowerCase();
  return path.join(outputDir, `${stem}_${id}.${extension}`);
}

function riskRows(review) {
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...(review.risks || [])]
    .filter((risk) => risk.human_status !== "deleted")
    .sort((a, b) => (order[a.risk_level] ?? 9) - (order[b.risk_level] ?? 9));
}

function reportSummary(review) {
  const risks = riskRows(review);
  return {
    total: risks.length,
    critical: risks.filter((risk) => risk.risk_level === "critical").length,
    high: risks.filter((risk) => risk.risk_level === "high").length,
    medium: risks.filter((risk) => risk.risk_level === "medium").length,
    low: risks.filter((risk) => risk.risk_level === "low").length,
    pending: risks.filter((risk) => risk.human_status === "pending_review").length
  };
}

function textOf(value) {
  return String(value ?? "");
}

async function writeDocx(review, filePath, generatedAt) {
  const risks = riskRows(review);
  const summary = reportSummary(review);
  const children = [
    new Paragraph({ text: "合同审查报告", heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `项目：${textOf(review.project?.project_name || review.project?.project_id)}`, bold: true })] }),
    new Paragraph(`合同文件：${textOf(review.document?.fileName)}    文件版本：${textOf(review.project?.file_version_id)}`),
    new Paragraph(`审查版本：${textOf(review.review_version_id || "未命名审查版本")}    生成时间：${generatedAt}`),
    new Paragraph(`风险总览：共 ${summary.total} 条，严重 ${summary.critical} 条，高 ${summary.high} 条，中 ${summary.medium} 条，低 ${summary.low} 条，待复核 ${summary.pending} 条`),
    new Paragraph({ text: "风险清单", heading: HeadingLevel.HEADING_1 })
  ];

  for (const [index, risk] of risks.entries()) {
    const location = risk.contract_location || {};
    children.push(
      new Paragraph({ text: `${index + 1}. ${textOf(risk.title)}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph(`等级：${textOf(risk.risk_level)}    类别：${textOf(risk.risk_category || "未分类")}    人工状态：${textOf(risk.human_status || "未记录")}`),
      new Paragraph(`位置：第 ${textOf(location.page || "?")} 页 ${textOf(location.clause_no || "")}    文件版本：${textOf(location.file_version_id || "")}`),
      new Paragraph(`原文：${textOf(location.quote || "未提供")}`),
      new Paragraph(`分析：${textOf(risk.analysis || "未提供")}`),
      new Paragraph(`建议：${textOf(risk.suggestion || "未提供")}`),
      new Paragraph(`证据状态：${textOf(risk.evidence_status || "未记录")}    结论状态：${textOf(risk.conclusion_status || "未记录")}`)
    );
  }
  children.push(
    new Paragraph({ text: "审查配置", heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`法律快照：${textOf(review.config?.snapshot?.id || "未绑定")}`),
    new Paragraph(`确定性规则：${(review.config?.rules || []).join("、") || "未绑定"}`),
    new Paragraph(`企业制度：${(review.config?.policies || []).join("、") || "未绑定"}`),
    new Paragraph(`模板版本：${TEMPLATE_VERSION}`)
  );
  const document = new Document({ sections: [{ children }] });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));
}

function wrapText(value, maxLength = 54) {
  const text = textOf(value);
  const result = [];
  for (let offset = 0; offset < text.length; offset += maxLength) result.push(text.slice(offset, offset + maxLength));
  return result.length ? result : [""];
}

function findCjkFont() {
  const candidates = [
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\msyh.ttf",
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function createPdfFont(pdf) {
  const fontPath = findCjkFont();
  if (fontPath) {
    try {
      const fontkit = require("@pdf-lib/fontkit");
      pdf.registerFontkit(fontkit);
      return {
        font: await pdf.embedFont(fs.readFileSync(fontPath), { subset: true }),
        supportsUnicode: true
      };
    } catch (_error) {
      // 字体不可嵌入时回退到标准字体，保证导出任务仍能生成可打开的 PDF。
    }
  }
  return {
    font: await pdf.embedFont(StandardFonts.Helvetica),
    supportsUnicode: false
  };
}

async function writePdf(review, filePath, generatedAt) {
  const pdf = await PDFDocument.create();
  const fontResult = await createPdfFont(pdf);
  const font = fontResult.font;
  const titleFont = fontResult.font;
  const pageSize = { width: 595, height: 842 };
  let page = pdf.addPage([pageSize.width, pageSize.height]);
  let cursor = 800;
  const margin = 42;
  const lineHeight = 16;

  function ensureSpace(lines = 1) {
    if (cursor - lines * lineHeight < 42) {
      page = pdf.addPage([pageSize.width, pageSize.height]);
      cursor = 800;
    }
  }
  function drawLines(value, options = {}) {
    const lines = wrapText(value, options.maxLength || 54);
    for (const line of lines) {
      ensureSpace();
      const renderableLine = fontResult.supportsUnicode
        ? line
        : line.replace(/[^\x00-\x7F]/g, "?");
      page.drawText(renderableLine || " ", {
        x: margin,
        y: cursor,
        size: options.size || 10,
        font: options.font || font,
        color: options.color || rgb(0.1, 0.13, 0.2)
      });
      cursor -= options.lineHeight || lineHeight;
    }
  }

  drawLines("合同审查报告", { size: 20, font: titleFont, lineHeight: 28, maxLength: 40 });
  drawLines(`项目：${textOf(review.project?.project_name || review.project?.project_id)}`);
  drawLines(`合同文件：${textOf(review.document?.fileName)}    文件版本：${textOf(review.project?.file_version_id)}`);
  drawLines(`审查版本：${textOf(review.review_version_id || "未命名审查版本")}    生成时间：${generatedAt}`);
  cursor -= 8;
  drawLines("风险清单", { size: 14, font: titleFont, lineHeight: 22, maxLength: 40 });
  for (const [index, risk] of riskRows(review).entries()) {
    const location = risk.contract_location || {};
    drawLines(`${index + 1}. ${textOf(risk.title)}`, { size: 12, font: titleFont, lineHeight: 18, maxLength: 48 });
    drawLines(`等级：${textOf(risk.risk_level)}    人工状态：${textOf(risk.human_status || "未记录")}`);
    drawLines(`位置：第 ${textOf(location.page || "?")} 页 ${textOf(location.clause_no || "")}`);
    drawLines(`原文：${textOf(location.quote || "未提供")}`);
    drawLines(`分析：${textOf(risk.analysis || "未提供")}`);
    drawLines(`建议：${textOf(risk.suggestion || "未提供")}`);
    cursor -= 6;
  }
  cursor -= 4;
  drawLines(`法律快照：${textOf(review.config?.snapshot?.id || "未绑定")}`);
  drawLines(`模板版本：${TEMPLATE_VERSION}`);
  fs.writeFileSync(filePath, await pdf.save());
}

async function writeXlsx(review, filePath, generatedAt) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "合同审查 Agent";
  workbook.created = new Date(generatedAt);
  const sheet = workbook.addWorksheet("审查风险清单");
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.columns = [
    { header: "风险等级", key: "level", width: 12 },
    { header: "风险标题", key: "title", width: 34 },
    { header: "风险类别", key: "category", width: 16 },
    { header: "合同页码", key: "page", width: 12 },
    { header: "条款号", key: "clause", width: 14 },
    { header: "原文片段", key: "quote", width: 60 },
    { header: "风险分析", key: "analysis", width: 60 },
    { header: "修改建议", key: "suggestion", width: 60 },
    { header: "证据状态", key: "evidence", width: 16 },
    { header: "人工状态", key: "human", width: 16 }
  ];
  sheet.mergeCells("A1:J1");
  sheet.getCell("A1").value = `${textOf(review.project?.project_name || "合同审查")} - 风险清单`;
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B4ACB" } };
  sheet.mergeCells("A2:J2");
  sheet.getCell("A2").value = `审查版本：${textOf(review.review_version_id || "未命名")}    文件版本：${textOf(review.project?.file_version_id)}    导出时间：${generatedAt}`;
  sheet.getRow(3).values = sheet.columns.map((column) => column.header);
  sheet.getRow(3).font = { bold: true, color: { argb: "FF1A2233" } };
  sheet.getRow(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1FB" } };
  sheet.autoFilter = "A3:J3";
  for (const risk of riskRows(review)) {
    const location = risk.contract_location || {};
    sheet.addRow({
      level: risk.risk_level || "",
      title: risk.title || "",
      category: risk.risk_category || "",
      page: location.page || "",
      clause: location.clause_no || "",
      quote: location.quote || "",
      analysis: risk.analysis || "",
      suggestion: risk.suggestion || "",
      evidence: risk.evidence_status || "",
      human: risk.human_status || ""
    });
  }
  for (const row of sheet.getRows(4, sheet.rowCount) || []) {
    row.alignment = { vertical: "top", wrapText: true };
  }
  await workbook.xlsx.writeFile(filePath);
}

function writeJson(review, filePath, generatedAt) {
  const payload = {
    export_version: TEMPLATE_VERSION,
    exported_at: generatedAt,
    review_version_id: review.review_version_id || null,
    file_version_id: review.project?.file_version_id || null,
    project: review.project || null,
    document: review.document || null,
    config: review.config || null,
    summary: reportSummary(review),
    risks: riskRows(review),
    humanRevisions: review.humanRevisions || []
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function exportReview({ review, formats, outputDir }) {
  const requestedFormats = [...new Set((Array.isArray(formats) ? formats : []).map((format) => String(format).toUpperCase()))];
  const validation = validateReview(review, { formats: requestedFormats });
  if (!validation.canExport) return { records: [], validation };
  if (!outputDir) {
    const error = new Error("未指定导出目录");
    error.code = "OUTPUT_DIRECTORY_MISSING";
    throw error;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = safeFileName(review.project?.project_name || review.document?.fileName || "合同审查");
  const generatedAt = new Date().toISOString();
  const records = [];

  for (const format of requestedFormats) {
    const id = exportId(format);
    const filePath = outputPath(outputDir, stem, format, id);
    if (format === "DOCX") await writeDocx(review, filePath, generatedAt);
    if (format === "PDF") await writePdf(review, filePath, generatedAt);
    if (format === "XLSX") await writeXlsx(review, filePath, generatedAt);
    if (format === "JSON") writeJson(review, filePath, generatedAt);
    records.push({
      export_id: id,
      format,
      status: "completed",
      filePath,
      generated_at: generatedAt,
      review_version_id: review.review_version_id || null,
      file_version_id: review.project?.file_version_id || null,
      template_version: TEMPLATE_VERSION
    });
  }
  return { records, validation };
}

module.exports = { exportReview, TEMPLATE_VERSION };
