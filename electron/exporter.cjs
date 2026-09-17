const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Document, HeadingLevel, Paragraph, Packer, TextRun, Header } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const ExcelJS = require("exceljs");
const { validateReview } = require("./validator.cjs");

const TEMPLATE_VERSION = "review-report@2.0.0";

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

function reportContext(validation) {
  const draft = validation.mode === "draft";
  return {
    draft,
    title: draft ? "合同审查报告 草稿" : "合同审查报告 正式版",
    notice: draft ? "草稿 DRAFT / NOT FINAL：仅供核验与讨论，不代表已完成法务确认，不得作为正式审查结论。"
      : "正式报告：本次导出已通过正式报告校验。",
    issues: validation.items.filter((item) => item.status !== "passed")
  };
}

function locationText(review, risk) {
  const location = risk.contract_location || {};
  const ref = location.source_refs?.[0] || location;
  const block = review.document?.blocks?.find((item) => item.block_id === ref.block_id);
  const clause = location.clause_no ? ` 条款 ${location.clause_no}` : "";
  if (location.location_status === "unresolved" || location.location_status === "fallback") {
    const missing = [...(review.check_results || []), ...(review.checklist_results || [])]
      .some((check) => check.status === "missing" && (check.check_id === risk.rule_id || risk.related_checks?.includes(check.check_id)));
    return missing ? "缺失项待核验（无具体条款定位）" : "待定位，原文锚点尚未核验";
  }
  if (review.document?.documentType === "docx") {
    const logicalPage = ref.logical_page || block?.logical_page;
    return `${block ? `逻辑块 ${block.block_id}` : "逻辑块待定位"}${logicalPage ? ` / 逻辑页 ${logicalPage}` : ""}${clause}（物理页码未确认）`;
  }
  return `${location.page ? `第 ${location.page} 页` : "待定位"}${clause}`;
}

function issueText(issue) {
  return `${issue.riskId ? `${issue.riskId} / ` : ""}${issue.label} [${issue.code}]：${issue.message}；${issue.suggestion}`;
}

async function writeDocx(review, filePath, generatedAt, validation) {
  const risks = riskRows(review);
  const summary = reportSummary(review);
  const context = reportContext(validation);
  const children = [
    new Paragraph({ text: context.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: context.notice, bold: true, color: context.draft ? "9C3B10" : "000000" })] }),
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
      new Paragraph(`位置：${locationText(review, risk)}    文件版本：${textOf(location.file_version_id || "")}`),
      new Paragraph(`原文：${textOf(location.quote || "未提供")}`),
      new Paragraph(`分析：${textOf(risk.analysis || "未提供")}`),
      new Paragraph(`建议：${textOf(risk.suggestion || "未提供")}`),
      new Paragraph(`证据状态：${textOf(risk.evidence_status || "未记录")}    结论状态：${textOf(risk.conclusion_status || "未记录")}`)
    );
  }
  if (context.issues.length) {
    children.push(new Paragraph({ text: "待核验事项", heading: HeadingLevel.HEADING_1 }));
    context.issues.forEach((issue) => children.push(new Paragraph(issueText(issue))));
  }
  children.push(
    new Paragraph({ text: "审查配置", heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`法律快照：${textOf(review.config?.snapshot?.id || "未绑定")}`),
    new Paragraph(`确定性规则：${(review.config?.rules || []).join("、") || "未绑定"}`),
    new Paragraph(`企业制度：${(review.config?.policies || []).join("、") || "未绑定"}`),
    new Paragraph(`模板版本：${TEMPLATE_VERSION}`)
  );
  const document = new Document({
    styles: { default: {
      document: { run: { font: "Microsoft YaHei", size: 21 }, paragraph: { spacing: { after: 120 } } },
      title: { run: { color: "000000" } }, heading1: { run: { color: "000000" } }, heading2: { run: { color: "000000" } }
    } },
    sections: [{
      headers: { default: new Header({ children: [new Paragraph(context.draft ? "草稿 DRAFT / NOT FINAL" : "合同审查报告 正式版")] }) },
      children
    }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));
}

function wrapText(value, font, size, maxWidth) {
  const result = [];
  for (const paragraph of textOf(value).split(/\r?\n/)) {
    let line = "";
    for (const char of paragraph) {
      if (line && font.widthOfTextAtSize(line + char, size) > maxWidth) {
        result.push(line);
        line = "";
      }
      line += char;
    }
    result.push(line);
  }
  return result;
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

async function writePdf(review, filePath, generatedAt, validation) {
  const context = reportContext(validation);
  const pdf = await PDFDocument.create();
  const fontResult = await createPdfFont(pdf);
  const font = fontResult.font;
  const titleFont = fontResult.font;
  const pageSize = { width: 595, height: 842 };
  let page;
  let cursor;
  const margin = 42;
  const lineHeight = 16;
  function addPage() {
    page = pdf.addPage([pageSize.width, pageSize.height]);
    cursor = 780;
    page.drawText(context.draft ? "DRAFT - NOT FINAL" : "FORMAL REPORT", {
      x: margin, y: 815, font, size: 10, color: context.draft ? rgb(0.6, 0.2, 0.08) : rgb(0, 0, 0)
    });
  }
  addPage();

  function ensureSpace(lines = 1) {
    if (cursor - lines * lineHeight < 42) {
      addPage();
    }
  }
  function drawLines(value, options = {}) {
    const size = options.size || 10;
    const renderable = fontResult.supportsUnicode ? textOf(value) : textOf(value).replace(/[^\x00-\x7F]/g, "?");
    const lines = wrapText(renderable, font, size, pageSize.width - margin * 2);
    for (const line of lines) {
      ensureSpace();
      page.drawText(line || " ", {
        x: margin,
        y: cursor,
        size,
        font: options.font || font,
        color: options.color || rgb(0.1, 0.13, 0.2)
      });
      cursor -= options.lineHeight || lineHeight;
    }
  }

  drawLines(context.title, { size: 20, font: titleFont, lineHeight: 28 });
  drawLines(context.notice);
  drawLines(`项目：${textOf(review.project?.project_name || review.project?.project_id)}`);
  drawLines(`合同文件：${textOf(review.document?.fileName)}    文件版本：${textOf(review.project?.file_version_id)}`);
  drawLines(`审查版本：${textOf(review.review_version_id || "未命名审查版本")}    生成时间：${generatedAt}`);
  cursor -= 8;
  drawLines("风险清单", { size: 14, font: titleFont, lineHeight: 22 });
  for (const [index, risk] of riskRows(review).entries()) {
    const location = risk.contract_location || {};
    drawLines(`${index + 1}. ${textOf(risk.title)}`, { size: 12, font: titleFont, lineHeight: 18 });
    drawLines(`等级：${textOf(risk.risk_level)}    人工状态：${textOf(risk.human_status || "未记录")}`);
    drawLines(`位置：${locationText(review, risk)}`);
    drawLines(`原文：${textOf(location.quote || "未提供")}`);
    drawLines(`分析：${textOf(risk.analysis || "未提供")}`);
    drawLines(`建议：${textOf(risk.suggestion || "未提供")}`);
    drawLines(`证据状态：${textOf(risk.evidence_status)}    结论状态：${textOf(risk.conclusion_status)}`);
    cursor -= 6;
  }
  cursor -= 4;
  drawLines(`法律快照：${textOf(review.config?.snapshot?.id || "未绑定")}`);
  drawLines(`模板版本：${TEMPLATE_VERSION}`);
  if (context.issues.length) {
    cursor -= 10;
    drawLines("待核验事项", { size: 14, lineHeight: 22 });
    context.issues.forEach((issue) => drawLines(issueText(issue)));
  }
  pdf.setTitle(context.title);
  pdf.setSubject(context.notice);
  fs.writeFileSync(filePath, await pdf.save());
}

async function writeXlsx(review, filePath, generatedAt, validation) {
  const context = reportContext(validation);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "合同审查 Agent";
  workbook.created = new Date(generatedAt);
  const sheet = workbook.addWorksheet("审查风险清单");
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.columns = [
    { header: "风险等级", key: "level", width: 12 },
    { header: "风险标题", key: "title", width: 34 },
    { header: "风险类别", key: "category", width: 16 },
    { header: "合同定位", key: "page", width: 34 },
    { header: "条款号", key: "clause", width: 14 },
    { header: "原文片段", key: "quote", width: 60 },
    { header: "风险分析", key: "analysis", width: 60 },
    { header: "修改建议", key: "suggestion", width: 60 },
    { header: "证据状态", key: "evidence", width: 16 },
    { header: "人工状态", key: "human", width: 16 }
  ];
  sheet.mergeCells("A1:J1");
  sheet.getCell("A1").value = `${textOf(review.project?.project_name || "合同审查")} - ${context.draft ? "草稿 DRAFT / NOT FINAL" : "正式报告"}`;
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
      page: locationText(review, risk),
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
  const checks = workbook.addWorksheet("导出校验");
  checks.columns = [{ key: "risk", width: 28 }, { key: "label", width: 24 }, { key: "code", width: 40 }, { key: "message", width: 70 }, { key: "suggestion", width: 60 }];
  checks.mergeCells("A1:E1");
  checks.getCell("A1").value = context.notice;
  checks.getCell("A1").font = { bold: true };
  checks.getCell("A1").alignment = { wrapText: true };
  checks.getRow(1).height = 42;
  checks.getRow(2).values = ["风险标识", "待核验项目", "校验代码", "问题", "处理建议"];
  context.issues.forEach((issue) => checks.addRow({ risk: issue.riskId || "整体审查", label: issue.label, code: issue.code, message: issue.message, suggestion: issue.suggestion }));
  if (!context.issues.length) checks.addRow({ message: "本次导出没有未处理的校验项" });
  checks.views = [{ state: "frozen", ySplit: 2 }];
  checks.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
  await workbook.xlsx.writeFile(filePath);
}

function writeJson(review, filePath, generatedAt, validation) {
  const payload = {
    export_version: TEMPLATE_VERSION,
    exported_at: generatedAt,
    export_mode: validation.mode,
    report_status: validation.mode === "draft" ? "draft" : "formal",
    export_notice: reportContext(validation).notice,
    validation,
    review_version_id: review.review_version_id || null,
    file_version_id: review.project?.file_version_id || null,
    project: review.project || null,
    document: review.document || null,
    config: review.config || null,
    checklist_version: review.checklist_version || null,
    checklist_results: review.checklist_results || [],
    checklist_coverage: review.checklist_coverage || null,
    check_results: review.check_results || [],
    coverage: review.coverage || null,
    contract_facts: review.contract_facts || [],
    fact_warnings: review.fact_warnings || [],
    execution_summary: review.execution_summary || null,
    model_context: review.model_context || null,
    summary: reportSummary(review),
    risks: riskRows(review),
    humanRevisions: review.humanRevisions || []
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function exportReview({ review, formats, outputDir, mode = "formal" }) {
  const requestedFormats = [...new Set((Array.isArray(formats) ? formats : []).map((format) => String(format).toUpperCase()))];
  const validation = validateReview(review, { formats: requestedFormats, mode });
  if (!validation.canExport) return { records: [], validation };
  if (!outputDir) {
    const error = new Error("未指定导出目录");
    error.code = "OUTPUT_DIRECTORY_MISSING";
    throw error;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = `${safeFileName(review.project?.project_name || review.document?.fileName || "合同审查")}_${mode === "draft" ? "草稿" : "正式"}`;
  const generatedAt = new Date().toISOString();
  const records = [];

  for (const format of requestedFormats) {
    const id = exportId(format);
    const filePath = outputPath(outputDir, stem, format, id);
    if (format === "DOCX") await writeDocx(review, filePath, generatedAt, validation);
    if (format === "PDF") await writePdf(review, filePath, generatedAt, validation);
    if (format === "XLSX") await writeXlsx(review, filePath, generatedAt, validation);
    if (format === "JSON") writeJson(review, filePath, generatedAt, validation);
    records.push({
      export_id: id,
      format,
      status: "completed",
      export_mode: mode,
      report_status: mode === "draft" ? "draft" : "formal",
      policy_version: validation.policyVersion,
      warning_codes: validation.warningCodes,
      formal_ready: validation.formalReady,
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
