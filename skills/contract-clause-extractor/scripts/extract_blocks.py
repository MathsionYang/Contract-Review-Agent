#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_blocks.py — 把 docx / PDF 合同转成「有序块」JSON，供条款抽取使用。

用法
----
    python extract_blocks.py <文件> [--out 输出.json] [--summary] [--ocr-threshold 50]

输出结构
--------
    {
      "file": "...",
      "format": "docx" | "pdf",
      "needs_ocr": false,
      "page_count": null,
      "block_count": 153,
      "blocks": [
        {"i": 0, "page": null, "kind": "paragraph", "text": "...",
         "style": "Normal", "heading_level": 0, "numbering": null,
         "page_break_before": false, "inline_page_break": false},
        {"i": 1, "page": null, "kind": "table", "rows": 8, "cols": 7,
         "markdown": "| ... |"}
      ]
    }

为什么不用 editor_sdk MCP 取全文
--------------------------------
本地 editor_sdk 的 doc_resolve_document_structure 返回的 text_preview 按
**UTF-8 字节**截断（text_preview_length 名义按字符、实际按字节；取值 200 时
纯中文只剩约 66 字），长条文取不到全文。本脚本直读 docx/PDF，不截断。
该 MCP 接口仅适合用来交叉核对块数与顺序。

已知限制
--------
- 仅支持 .docx；.doc / .wps 需先另存为 .docx。
- python-docx 对合并单元格会重复输出同一文本，转 Markdown 时不做合并语义还原。
- 文本框（textbox）、页眉页脚内的条款正文不采集。
- PDF 无版面模型时按"空行分段 + 编号断行"启发式合并，复杂多栏排版可能需人工校正。
"""

import argparse
import json
import os
import re
import sys

CN_NUM = '一二三四五六七八九十百'
# PDF 行首编号：第X条 / 第X章 / 一、 / 1. / 1.1 / （1）
RE_LINE_START = re.compile(
    r'^(第\s*[' + CN_NUM + r'\d]+\s*[条章节]'
    r'|[' + CN_NUM + r']+\s*[、.]'
    r'|\d+\s*[、.]\s*\d*'
    r'|（\s*\d+\s*）|\(\s*\d+\s*\))'
)


# ---------------------------------------------------------------- docx

def _docx_para_meta(p_el, doc):
    """读单个 w:p 的样式 / 标题级别 / 编号 / 分页信息。"""
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    p = Paragraph(p_el, doc)
    text = p.text.strip()

    style = ''
    try:
        style = p.style.name or ''
    except Exception:
        pass

    heading_level = 0
    pPr = p_el.pPr
    if pPr is not None:
        olvl = pPr.find(qn('w:outlineLvl'))
        if olvl is not None:
            try:
                heading_level = int(olvl.get(qn('w:val'))) + 1
            except (TypeError, ValueError):
                pass
    if not heading_level:
        m = re.match(r'^(?:Heading|标题)\s*(\d+)', style, re.I)
        if m:
            heading_level = int(m.group(1))

    numbering = None
    page_break_before = False
    if pPr is not None:
        numPr = pPr.find(qn('w:numPr'))
        if numPr is not None:
            num_id = numPr.find(qn('w:numId'))
            ilvl = numPr.find(qn('w:ilvl'))
            if num_id is not None:
                numbering = {
                    'numId': num_id.get(qn('w:val')),
                    'ilvl': ilvl.get(qn('w:val')) if ilvl is not None else '0',
                }
        pbb = pPr.find(qn('w:pageBreakBefore'))
        if pbb is not None:
            val = pbb.get(qn('w:val'))
            page_break_before = val not in ('0', 'false')

    inline_break = any(
        br.get(qn('w:type')) == 'page'
        for br in p_el.iter(qn('w:br'))
    )

    return {
        'text': text,
        'style': style,
        'heading_level': heading_level,
        'numbering': numbering,
        'page_break_before': page_break_before,
        'inline_page_break': inline_break,
    }


def _table_to_markdown(tbl):
    rows = []
    for row in tbl.rows:
        cells = []
        for c in row.cells:
            t = ' '.join((c.text or '').split())
            cells.append(t.replace('|', '\\|'))
        rows.append(cells)
    if not rows:
        return '', 0, 0
    ncol = max(len(r) for r in rows)
    rows = [r + [''] * (ncol - len(r)) for r in rows]
    lines = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * ncol]
    for r in rows[1:]:
        lines.append('| ' + ' | '.join(r) + ' |')
    return '\n'.join(lines), len(rows), ncol


def read_docx(path):
    from docx import Document
    from docx.table import Table
    from docx.oxml.ns import qn

    doc = Document(path)
    blocks = []
    idx = 0
    for child in doc.element.body.iterchildren():
        if child.tag == qn('w:p'):
            meta = _docx_para_meta(child, doc)
            if not meta['text']:
                continue
            blocks.append({
                'i': idx, 'page': None, 'kind': 'paragraph',
                **meta,
            })
            idx += 1
        elif child.tag == qn('w:tbl'):
            md, nrows, ncols = _table_to_markdown(Table(child, doc))
            if not md:
                continue
            blocks.append({
                'i': idx, 'page': None, 'kind': 'table',
                'rows': nrows, 'cols': ncols, 'markdown': md,
            })
            idx += 1
    return blocks, None


# ---------------------------------------------------------------- pdf

def _pdf_pages(path):
    """返回 [(page_no, text), ...]。优先 PyMuPDF，其次 pdfplumber，再次 pypdf。"""
    try:
        import fitz  # PyMuPDF
        with fitz.open(path) as d:
            return [(i + 1, p.get_text() or '') for i, p in enumerate(d)]
    except ImportError:
        pass

    try:
        import pdfplumber
        out = []
        with pdfplumber.open(path) as d:
            for i, p in enumerate(d.pages):
                out.append((i + 1, p.extract_text() or ''))
        return out
    except ImportError:
        pass

    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            raise RuntimeError(
                '未安装 PDF 解析库。请安装其中之一：pymupdf / pdfplumber / pypdf'
            )
    reader = PdfReader(path)
    return [(i + 1, (p.extract_text() or '')) for i, p in enumerate(reader.pages)]


def _pdf_page_blocks(text, page):
    """把一页文本切成块：空行分段；段内遇到行首编号则断为新块。"""
    blocks = []
    for group in re.split(r'\n\s*\n', text):
        buf = []
        for line in group.splitlines():
            s = line.strip()
            if not s:
                continue
            if buf and RE_LINE_START.match(s):
                blocks.append(' '.join(buf))
                buf = [s]
            else:
                buf.append(s)
        if buf:
            blocks.append(' '.join(buf))
    return blocks


def read_pdf(path, ocr_threshold):
    pages = _pdf_pages(path)
    page_count = len(pages)
    total_chars = sum(len(t.strip()) for _, t in pages)
    needs_ocr = page_count > 0 and (total_chars / page_count) < ocr_threshold

    blocks = []
    idx = 0
    if not needs_ocr:
        for pno, text in pages:
            for t in _pdf_page_blocks(text, pno):
                blocks.append({
                    'i': idx, 'page': pno, 'kind': 'paragraph', 'text': t,
                    'style': '', 'heading_level': 0, 'numbering': None,
                    'page_break_before': False, 'inline_page_break': False,
                })
                idx += 1
    return blocks, page_count, needs_ocr, total_chars


# ---------------------------------------------------------------- main

def extract(path, ocr_threshold=50):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.docx', '.docm'):
        blocks, _ = read_docx(path)
        return {
            'file': os.path.basename(path), 'format': 'docx',
            'needs_ocr': False, 'page_count': None,
            'page': None, 'block_count': len(blocks), 'blocks': blocks,
        }
    if ext in ('.pdf',):
        blocks, page_count, needs_ocr, total_chars = read_pdf(path, ocr_threshold)
        return {
            'file': os.path.basename(path), 'format': 'pdf',
            'needs_ocr': needs_ocr, 'page_count': page_count,
            'total_chars': total_chars, 'block_count': len(blocks),
            'blocks': blocks,
        }
    if ext in ('.doc', '.wps', '.wpt', '.dot'):
        raise RuntimeError('不支持 %s，请先用客户端另存为 .docx' % ext)
    raise RuntimeError('不支持的格式：%s（仅支持 .docx / .pdf）' % ext)


def main():
    ap = argparse.ArgumentParser(description='docx / PDF → 有序块 JSON')
    ap.add_argument('file', help='待抽取的 docx 或 PDF 路径')
    ap.add_argument('--out', help='输出 JSON 文件路径（不给则打印到 stdout）')
    ap.add_argument('--summary', action='store_true', help='只打印统计摘要')
    ap.add_argument('--ocr-threshold', type=int, default=50,
                    help='扫描件判定阈值：每页平均字符数，默认 50')
    args = ap.parse_args()

    if not os.path.isfile(args.file):
        sys.stderr.write('文件不存在：%s\n' % args.file)
        return 2

    result = extract(args.file, args.ocr_threshold)

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    if args.summary:
        kinds = {}
        for b in result['blocks']:
            kinds[b['kind']] = kinds.get(b['kind'], 0) + 1
        print('%s | format=%s | needs_ocr=%s | blocks=%d %s'
              % (result['file'], result['format'], result['needs_ocr'],
                 result['block_count'], kinds))
        for b in result['blocks'][:5]:
            t = b.get('text') or b.get('markdown', '')[:40]
            print('  [%d] %s %s' % (b['i'], b['kind'], t[:70]))
        if result['block_count'] > 5:
            print('  ... 共 %d 块' % result['block_count'])
        if args.out:
            print('已写入：%s' % args.out)
        return 0

    if not args.out:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
