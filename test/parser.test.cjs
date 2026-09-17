const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { parseContract } = require("../electron/parser.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-parser-"));
}

test("解析器在读取内容前拒绝不支持的扩展名", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "malware.exe");
  fs.writeFileSync(filePath, "not a contract");

  await assert.rejects(
    () => parseContract(filePath),
    (error) => error.code === "UNSUPPORTED_FILE_TYPE"
  );
});

test("解析 DOCX 时返回正文、页信息和 SHA-256", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "采购合同.docx");
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun("甲方：华东供应链有限公司")] }),
        new Paragraph({ children: [new TextRun("第一条 合同标的与付款")] })
      ]
    }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));

  const parsed = await parseContract(filePath);

  assert.equal(parsed.extension, ".docx");
  assert.match(parsed.text, /华东供应链有限公司/);
  assert.equal(parsed.pageCount, 1);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.pages[0].page, 1);
  assert.ok(Array.isArray(parsed.blocks));
  assert.ok(parsed.blocks.some((block) => block.block_type === "paragraph" && block.text.includes("华东供应链")));
});

test("解析 DOCX 时保留表格单元格证据块", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "表格合同.docx");
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun("第二条 合同价款")] }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph("项目")] }), new TableCell({ children: [new Paragraph("金额")] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph("软件许可")] }), new TableCell({ children: [new Paragraph("960000")] })] })
          ]
        })
      ]
    }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));

  const parsed = await parseContract(filePath);
  const cells = parsed.blocks.filter((block) => block.block_type === "table_cell");

  assert.ok(cells.length >= 4);
  assert.ok(cells.some((block) => block.text === "960000" && block.table_ref.row === 1 && block.table_ref.column === 1));
  assert.ok(cells.every((block) => typeof block.text_hash === "string" && block.text_hash.startsWith("sha256:")));
});

test("DOCX 证据块偏移对应原始正文并区分重复段落", async () => {
  const filePath = path.join(tempDir(), "重复段落合同.docx");
  const repeated = "甲方  应当支付价款。";
  const document = new Document({
    sections: [{ children: [
      new Paragraph("第一条  合同标的"),
      new Paragraph(repeated),
      new Table({ rows: [new TableRow({ children: [
        new TableCell({ children: [new Paragraph("软件许可")] }),
        new TableCell({ children: [new Paragraph("960000")] })
      ] })] }),
      new Paragraph(repeated)
    ] }]
  });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));
  const parsed = await parseContract(filePath);
  const normalized = (value) => value.replace(/\s+/g, " ").trim();
  let previousEnd = 0;
  for (const block of parsed.blocks) {
    assert.ok(Array.isArray(block.char_range), block.block_id);
    const [start, end] = block.char_range;
    assert.ok(start >= previousEnd, block.block_id);
    assert.equal(normalized(parsed.text.slice(start, end)), block.text, block.block_id);
    previousEnd = end;
  }
  const matches = parsed.blocks.filter((block) => block.text === normalized(repeated));
  assert.equal(matches.length, 2);
  assert.notDeepEqual(matches[0].char_range, matches[1].char_range);
});

test("表格编号按表序号连续生成，且表格不跨越估算逻辑页", async () => {
  const { parseContract } = require("../electron/parser.cjs");
  const dir = tempDir();
  const filePath = path.join(dir, "多表合同.docx");
  const table = (rows) => new Table({ rows: rows.map((cells) => new TableRow({ children: cells.map((text) => new TableCell({ children: [new Paragraph(text)] })) })) });
  const document = new Document({ sections: [{ children: [
    new Paragraph("第一条 当事人"),
    table([["项目", "甲方"], ["名称", "瀚元智能装备制造有限公司"]]),
    new Paragraph("第二条 标的"),
    table([["序号", "项目"], ["1", "MES 软件"]]),
    new Paragraph("第三条 价款"),
    table([["合计", "1286000"]])
  ] }] });
  fs.writeFileSync(filePath, await Packer.toBuffer(document));
  const parsed = await parseContract(filePath);
  const tableIds = [...new Set(parsed.blocks.filter((block) => block.table_ref).map((block) => block.table_ref.table_id))];
  // 编号必须从 table_1 起连续，不能用块序号拼出 table_3/table_44 这类值。
  assert.deepEqual(tableIds, ["table_1", "table_2", "table_3"]);
  // 同一张表的所有单元格必须落在同一个逻辑页，避免表格被跨页拆散。
  for (const tableId of tableIds) {
    const pages = new Set(parsed.blocks.filter((block) => block.table_ref?.table_id === tableId).map((block) => block.logical_page));
    assert.equal(pages.size, 1, `${tableId} 被拆到多个逻辑页：${[...pages].join(",")}`);
  }
  // 页数信息必须带状态，估算值不得冒充真实页码。
  assert.equal(typeof parsed.pageCount, "number");
  assert.ok(["resolved", "estimated", "unresolved"].includes(parsed.page_status), parsed.page_status);
  assert.ok(parsed.blocks.every((block) => block.page_status === parsed.page_status));
});

test("解析可搜索 PDF 时保留页码和文本层", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "采购合同.pdf");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Contract total: 2680000 RMB", {
    x: 40,
    y: 650,
    size: 14,
    font,
    color: rgb(0, 0, 0)
  });
  fs.writeFileSync(filePath, await pdf.save());

  const parsed = await parseContract(filePath);

  assert.equal(parsed.documentType, "searchable_pdf");
  assert.equal(parsed.pageCount, 1);
  assert.match(parsed.text, /2680000/);
  assert.equal(parsed.pages[0].ocr.status, "not_required");
  assert.ok(parsed.blocks.some((block) => block.page === 1 && block.text.includes("2680000")));
});
