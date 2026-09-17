const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Document, HeadingLevel, Paragraph, Packer, TextRun, Header, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const ExcelJS = require("exceljs");
const { validateReview } = require("./validator.cjs");

const TEMPLATE_VERSION = "review-report@2.1.0";

// 等级顺序与配色是四种导出格式共用的唯一来源：调整外观时只改这里。
const LEVEL_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const LEVEL_STYLE = {
  critical: { label: "严重", hex: "C0392B", argb: "FFC0392B", pdf: [0.75, 0.22, 0.17], weight: 4 },
  high: { label: "高", hex: "E8590C", argb: "FFE8590C", pdf: [0.91, 0.35, 0.05], weight: 3 },
  medium: { label: "中", hex: "B7791F", argb: "FFB7791F", pdf: [0.72, 0.47, 0.12], weight: 2 },
  low: { label: "低", hex: "2F855A", argb: "FF2F855A", pdf: [0.18, 0.52, 0.35], weight: 1 },
  info: { label: "提示", hex: "4A5568", argb: "FF4A5568", pdf: [0.29, 0.33, 0.41], weight: 0 }
};
const LEVEL_SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

function levelStyle(level) {
  return LEVEL_STYLE[String(level || "").toLowerCase()] || LEVEL_STYLE.info;
}

function levelLabel(level) {
  const style = levelStyle(level);
  return `${style.label}（${String(level || "info").toLowerCase()}）`;
}

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

// 风险排序：先按等级从严重到轻，同级再按"待人工复核优先 → 置信度低优先"，
// 最后用条款号与标题兜底，保证同一份审查每次导出的顺序完全一致。
function humanPriority(risk) {
  if (risk.human_status === "pending_review" || !risk.human_status) return 0;
  if (risk.human_status === "deferred") return 1;
  return 2;
}

function clauseSortKey(risk) {
  const clause = String(risk.contract_location?.clause_no || "");
  const numbers = clause.match(/\d+/g);
  return numbers ? numbers.map((value) => Number(value)).join(".") : `~${clause}`;
}

function riskRows(review) {
  return [...(review.risks || [])]
    .filter((risk) => risk.human_status !== "deleted")
    .sort((left, right) => {
      const byLevel = (LEVEL_ORDER[String(left.risk_level || "").toLowerCase()] ?? 9)
        - (LEVEL_ORDER[String(right.risk_level || "").toLowerCase()] ?? 9);
      if (byLevel) return byLevel;
      const byHuman = humanPriority(left) - humanPriority(right);
      if (byHuman) return byHuman;
      const byConfidence = (Number(left.location_confidence) || 0) - (Number(right.location_confidence) || 0);
      if (byConfidence) return byConfidence;
      const byClause = clauseSortKey(left).localeCompare(clauseSortKey(right), "zh-Hans-CN", { numeric: true });
      if (byClause) return byClause;
      return String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans-CN");
    });
}

// 图表模型：严重度分布（条形图数据），四种格式共用同一组数字。
function severityDistribution(review) {
  const risks = riskRows(review);
  return LEVEL_SEVERITY_ORDER.map((level) => {
    const style = LEVEL_STYLE[level];
    return { level, label: style.label, count: risks.filter((risk) => String(risk.risk_level || "").toLowerCase() === level).length,
      hex: style.hex, argb: style.argb, pdf: style.pdf, weight: style.weight };
  });
}

function maxSeverityCount(review) {
  const distribution = severityDistribution(review);
  return Math.max(1, ...distribution.map((item) => item.count));
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

/**
 * 报告头部上下文。
 * 需求：导出件是给业务/法务阅读的报告，不再携带门禁的"待核验事项"明细——
 * 那些代码、建议与校验项属于工具内部状态，平铺在报告里对读者没有帮助。
 * 门禁仍然照常工作（不通过就不导出），只是不再把明细写进文件。
 * 保留的只有"草稿/正式"这个对人最关键的结论性标记。
 */
function reportContext(validation) {
  const draft = validation.mode === "draft";
  return {
    draft,
    title: draft ? "合同审查报告 草稿" : "合同审查报告 正式版",
    notice: draft ? "草稿 DRAFT / NOT FINAL：仅供核验与讨论，不代表已完成法务确认，不得作为正式审查结论。"
      : "正式报告：本次导出已通过正式报告校验。"
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

// DOCX 里的"图表"用表格实现：Word 表中表格是最稳定、最兼容的可视化载体。
// 分布表每行用等级色块 + 等宽方块条表示数量，读者一眼能看出严重度构成。
function docxSeverityChart(review) {
  const distribution = severityDistribution(review);
  const peak = maxSeverityCount(review);
  const rows = [
    new TableRow({
      tableHeader: true,
      children: ["风险等级", "数量", "占比分布", "占比"].map((text) => new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "EFF1FB" },
        children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })]
      }))
    })
  ];
  const total = distribution.reduce((sum, item) => sum + item.count, 0);
  for (const item of distribution) {
    const filled = Math.round((item.count / peak) * 20);
    const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, 20 - filled))}`;
    const share = total ? `${Math.round((item.count / total) * 100)}%` : "0%";
    rows.push(new TableRow({
      children: [
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: item.hex },
          children: [new Paragraph({ children: [new TextRun({ text: item.label, bold: true, color: "FFFFFF" })] })]
        }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(item.count), bold: true })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: bar, color: item.hex })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: share })] })] })
      ]
    }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// 风险条款清单表格：等级列用等级色块，严重项自然排在最前。
function docxRiskTable(review) {
  const risks = riskRows(review);
  const header = ["#", "等级", "风险条款", "定位", "分析要点", "修改建议", "证据", "人工状态"];
  const rows = [new TableRow({
    tableHeader: true,
    children: header.map((text) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: "EFF1FB" },
      children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })]
    }))
  })];
  risks.forEach((risk, index) => {
    const style = levelStyle(risk.risk_level);
    const location = risk.contract_location || {};
    rows.push(new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(index + 1) })] })] }),
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: style.hex },
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: style.label, bold: true, color: "FFFFFF" })] })]
        }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(risk.title), bold: true })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: locationText(review, risk), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(risk.analysis || "未提供"), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(risk.suggestion || "未提供"), size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `${textOf(risk.evidence_status || "未记录")}${location.quote ? `\n${textOf(location.quote)}` : ""}`, size: 16 })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: textOf(risk.human_status || "未记录"), size: 18 })] })] })
      ]
    }));
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
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
    new Paragraph({ text: "风险等级分布", heading: HeadingLevel.HEADING_1 }),
    docxSeverityChart(review)
  ];

  children.push(
    new Paragraph({ text: "风险条款清单（按严重程度排序）", heading: HeadingLevel.HEADING_1 }),
    new Paragraph("同一等级内：待人工复核优先，其次按条款号顺序。"),
    docxRiskTable(review)
  );

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
  const contentWidth = pageSize.width - margin * 2;
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

  // 严重度分布条形图：用矩形直接绘制，不引入图形库。
  function drawSeverityChart() {
    const distribution = severityDistribution(review);
    const peak = maxSeverityCount(review);
    const barMaxWidth = contentWidth - 170;
    const rowHeight = 22;
    ensureSpace(distribution.length * rowHeight / lineHeight + 2);
    const labelWidth = 42;
    const countWidth = 30;
    for (const item of distribution) {
      const barWidth = Math.round((item.count / peak) * barMaxWidth);
      page.drawText(item.label, { x: margin, y: cursor, size: 10, font: titleFont, color: rgb(...item.pdf) });
      page.drawText(String(item.count), { x: margin + labelWidth, y: cursor, size: 10, font, color: rgb(0.1, 0.13, 0.2) });
      const barX = margin + labelWidth + countWidth;
      // 轨道底色保证数量为 0 时也能看出刻度
      page.drawRectangle({ x: barX, y: cursor - 3, width: barMaxWidth, height: 11, color: rgb(0.93, 0.94, 0.97) });
      if (barWidth > 0) page.drawRectangle({ x: barX, y: cursor - 3, width: barWidth, height: 11, color: rgb(...item.pdf) });
      cursor -= rowHeight;
    }
    cursor -= 4;
  }

  drawLines(context.title, { size: 20, font: titleFont, lineHeight: 28 });
  drawLines(context.notice);
  drawLines(`项目：${textOf(review.project?.project_name || review.project?.project_id)}`);
  drawLines(`合同文件：${textOf(review.document?.fileName)}    文件版本：${textOf(review.project?.file_version_id)}`);
  drawLines(`审查版本：${textOf(review.review_version_id || "未命名审查版本")}    生成时间：${generatedAt}`);
  const summary = reportSummary(review);
  drawLines(`风险总览：共 ${summary.total} 条，严重 ${summary.critical} 条，高 ${summary.high} 条，中 ${summary.medium} 条，低 ${summary.low} 条，待复核 ${summary.pending} 条`);
  cursor -= 6;
  drawLines("风险等级分布", { size: 14, font: titleFont, lineHeight: 22 });
  drawSeverityChart();
  drawLines("风险条款清单（按严重程度排序）", { size: 14, font: titleFont, lineHeight: 22 });

  // 每条风险用左侧等级色条 + 标题行，替代原来的纯文本段落，便于快速扫读。
  for (const [index, risk] of riskRows(review).entries()) {
    const style = levelStyle(risk.risk_level);
    const location = risk.contract_location || {};
    const bodyLines = [];
    const pushLine = (label, value) => {
      const renderable = fontResult.supportsUnicode ? textOf(value) : textOf(value).replace(/[^\x00-\x7F]/g, "?");
      const prefix = label ? `${label}：` : "";
      for (const line of wrapText(`${prefix}${renderable}`, font, 9, contentWidth - 26)) bodyLines.push({ line, bold: false });
    };
    bodyLines.push({ line: `${index + 1}. ${textOf(risk.title)}`, bold: true });
    pushLine("等级", `${levelLabel(risk.risk_level)}    类别：${textOf(risk.risk_category || "未分类")}    人工状态：${textOf(risk.human_status || "未记录")}`);
    pushLine("位置", locationText(review, risk));
    pushLine("原文", textOf(location.quote || "未提供"));
    pushLine("分析", textOf(risk.analysis || "未提供"));
    pushLine("建议", textOf(risk.suggestion || "未提供"));
    pushLine("证据", `${textOf(risk.evidence_status || "未记录")}    结论：${textOf(risk.conclusion_status || "未记录")}`);
    const blockHeight = bodyLines.length * 13 + 6;
    if (cursor - blockHeight < 42) { addPage(); }
    page.drawRectangle({ x: margin, y: cursor - (bodyLines.length - 1) * 13 - 4, width: 3, height: Math.max(12, blockHeight - 6), color: rgb(...style.pdf) });
    for (const item of bodyLines) {
      page.drawText(item.line || " ", {
        x: margin + 10, y: cursor, size: item.bold ? 11 : 9,
        font: item.bold ? titleFont : font,
        color: item.bold ? rgb(...style.pdf) : rgb(0.1, 0.13, 0.2)
      });
      cursor -= 13;
    }
    cursor -= 6;
  }
  cursor -= 4;
  drawLines(`法律快照：${textOf(review.config?.snapshot?.id || "未绑定")}`);
  drawLines(`模板版本：${TEMPLATE_VERSION}`);
  pdf.setTitle(context.title);
  pdf.setSubject(context.notice);
  fs.writeFileSync(filePath, await pdf.save());
}

// XLSX 的风险分布工作表。
// 注意：本项目使用的 ExcelJS 4.4 没有图表（chart）API，任何 addChart 写法都会被静默忽略，
// 生成的文件里不会有 chart 部件。因此这里用 Excel 原生支持的"条件格式数据条 + 等级色块"，
// 在 Excel/WPS 中同样是可视化的条形效果，且不会产生"看起来有图、实际没有"的假象。
function addSeverityChartSheet(workbook, review) {
  const distribution = severityDistribution(review);
  const sheet = workbook.addWorksheet("风险分布");
  sheet.columns = [{ key: "level", width: 18 }, { key: "count", width: 12 }, { key: "share", width: 12 }];
  sheet.mergeCells("A1:C1");
  sheet.getCell("A1").value = "风险等级分布";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getRow(2).values = ["风险等级", "数量", "占比"];
  sheet.getRow(2).font = { bold: true, color: { argb: "FF1A2233" } };
  sheet.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1FB" } };
  const total = distribution.reduce((sum, item) => sum + item.count, 0);
  for (const item of distribution) {
    const row = sheet.addRow([item.label, item.count, total ? item.count / total : 0]);
    row.getCell(3).numFmt = "0%";
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: item.argb } };
    row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.getCell(1).alignment = { horizontal: "center" };
    row.getCell(2).alignment = { horizontal: "center" };
  }
  // 数据条按等级逐行上色，数量多少一眼可读。
  distribution.forEach((item, index) => {
    sheet.addConditionalFormatting({
      ref: `B${3 + index}:B${3 + index}`,
      rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: false,
        color: { argb: item.argb }, cfvo: [{ type: "num", value: 0 }, { type: "max" }] }]
    });
  });
  return sheet;
}

async function writeXlsx(review, filePath, generatedAt, validation) {
  const context = reportContext(validation);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "合同审查 Agent";
  workbook.created = new Date(generatedAt);
  const sheet = workbook.addWorksheet("审查风险清单");
  addSeverityChartSheet(workbook, review);
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.columns = [
    { header: "排序", key: "rank", width: 7 },
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
  sheet.mergeCells("A1:K1");
  sheet.getCell("A1").value = `${textOf(review.project?.project_name || "合同审查")} - ${context.draft ? "草稿 DRAFT / NOT FINAL" : "正式报告"}`;
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B4ACB" } };
  sheet.mergeCells("A2:K2");
  sheet.getCell("A2").value = `审查版本：${textOf(review.review_version_id || "未命名")}    文件版本：${textOf(review.project?.file_version_id)}    导出时间：${generatedAt}`;
  sheet.getRow(3).values = sheet.columns.map((column) => column.header);
  sheet.getRow(3).font = { bold: true, color: { argb: "FF1A2233" } };
  sheet.getRow(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1FB" } };
  sheet.autoFilter = "A3:K3";
  // riskRows 已按严重度排好；等级列直接按等级上色，扫描时无需再读文字。
  let rank = 0;
  for (const risk of riskRows(review)) {
    const location = risk.contract_location || {};
    const style = levelStyle(risk.risk_level);
    rank += 1;
    const row = sheet.addRow({
      rank,
      level: style.label,
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
    row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.argb } };
    row.getCell(2).font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.getCell(1).alignment = { vertical: "top", horizontal: "center" };
    row.getCell(2).alignment = { vertical: "top", horizontal: "center" };
  }
  for (const row of sheet.getRows(4, sheet.rowCount) || []) {
    row.alignment = { vertical: "top", wrapText: true };
  }
  // 说明页：只保留"这份报告是什么状态"的结论性信息，不再平铺门禁校验明细。
  const notes = workbook.addWorksheet("报告说明");
  notes.columns = [{ key: "item", width: 22 }, { key: "value", width: 96 }];
  notes.mergeCells("A1:B1");
  notes.getCell("A1").value = context.notice;
  notes.getCell("A1").font = { bold: true, color: { argb: context.draft ? "FF9C3B10" : "FF1A2233" } };
  notes.getCell("A1").alignment = { wrapText: true, vertical: "middle" };
  notes.getRow(1).height = 44;
  const summary = reportSummary(review);
  for (const [item, value] of [
    ["报告状态", context.draft ? "草稿 / 待核验（不得作为正式审查结论）" : "正式报告"],
    ["项目", textOf(review.project?.project_name || review.project?.project_id)],
    ["合同文件", textOf(review.document?.fileName)],
    ["文件版本", textOf(review.project?.file_version_id)],
    ["审查版本", textOf(review.review_version_id || "未命名")],
    ["生成时间", generatedAt],
    ["风险总数", `${summary.total} 条（严重 ${summary.critical} / 高 ${summary.high} / 中 ${summary.medium} / 低 ${summary.low}）`],
    ["待人工复核", `${summary.pending} 条`],
    ["模板版本", TEMPLATE_VERSION]
  ]) notes.addRow([item, value]);
  notes.eachRow((row, index) => {
    if (index === 1) return;
    row.getCell(1).font = { bold: true };
    row.alignment = { vertical: "top", wrapText: true };
  });
  await workbook.xlsx.writeFile(filePath);
}

function writeJson(review, filePath, generatedAt, validation) {
  const payload = {
    export_version: TEMPLATE_VERSION,
    exported_at: generatedAt,
    export_mode: validation.mode,
    report_status: validation.mode === "draft" ? "draft" : "formal",
    export_notice: reportContext(validation).notice,
    // JSON 是数据交付物，不再内嵌门禁的逐项校验明细（那是工具内部状态）；
    // 只保留校验通过与否的结论与策略版本，便于机器判断报告是否可作为正式件使用。
    validation_summary: {
      can_export: validation.canExport,
      formal_ready: validation.formalReady,
      policy_version: validation.policyVersion,
      warning_codes: validation.warningCodes
    },
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
    // 图表数据与等级元信息：前端或第三方消费方无需自己再统计一遍。
    level_meta: LEVEL_SEVERITY_ORDER.map((level) => ({ level, label: LEVEL_STYLE[level].label, color: LEVEL_STYLE[level].hex })),
    severity_distribution: severityDistribution(review).map(({ level, label, count }) => ({ level, label, count })),
    risk_order: "risk_level desc, human_status(pending first), location_confidence asc, clause_no asc",
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
