const test = require("node:test");
const assert = require("node:assert/strict");
const { runGeneralChecklist } = require("../electron/general-checklist.cjs");
const { coverageFrom } = require("../electron/checklist-policy.cjs");

test("清单组件渲染 95 项、复核表单与原文跳转，工作区保留两个结果视图", async () => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  try {
    const { default: Checklist } = await server.ssrLoadModule("/src/components/ReviewChecklist.vue");
    const { default: Workspace } = await server.ssrLoadModule("/src/components/ReviewWorkspace.vue");
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useReviewStore();
    const document = { text: "2.1 甲方满意后支付尾款。", fileVersionId: "test-v1", documentType: "docx", sha256: "test-only",
      page_status: "estimated",
      pages: [{ page: 1, text: "2.1 甲方满意后支付尾款。" }],
      blocks: [{ block_id: "b1", page: null, logical_page: 1, text: "2.1 甲方满意后支付尾款。" }] };
    const result = runGeneralChecklist({ document });
    const project = { project_id: "ui-test", file_version_id: "test-v1" };
    store.state.projects = [project];
    store.state.activeProjectId = "ui-test";
    store.state.reviews = { "ui-test": { project, document, risks: result.findings, checklist_results: result.checkResults,
      checklist_version: result.catalogVersion, checklist_coverage: coverageFrom(result.checkResults) } };
    const html = await renderToString(createSSRApp(Checklist).use(pinia));
    assert.equal((html.match(/class="checklist-item"/g) || []).length, 95);
    assert.ok(html.includes("GC-6-10"));
    assert.ok(html.includes("保存复核"));
    assert.ok(html.includes("逻辑块定位"));
    const workspace = await renderToString(createSSRApp(Workspace).use(pinia));
    assert.ok(workspace.includes('id="checklist-results-panel"'));
    assert.ok(workspace.includes('id="risk-results-panel"'));
    // 页数是字符数估算，界面必须如实标注，不能写成确定的物理页码。
    assert.ok(workspace.includes("页数为估算值"));
  } finally {
    await server.close();
  }
});

test("合同阅读器把表格单元格还原成真实表格，而不是逐行散落的文本", async () => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  try {
    const { default: Workspace } = await server.ssrLoadModule("/src/components/ReviewWorkspace.vue");
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useReviewStore();
    const cell = (table_id, row, column, text) => ({ block_id: `${table_id}_${row}_${column}`, logical_page: 1, block_type: "table_cell", text,
      table_ref: { table_id, row, column } });
    const blocks = [
      { block_id: "p1", logical_page: 1, block_type: "paragraph", text: "第一条 合同标的" },
      cell("table_1", 0, 0, "序号"), cell("table_1", 0, 1, "项目"),
      cell("table_1", 1, 0, "1"), cell("table_1", 1, 1, "MES 软件"),
      cell("table_2", 0, 0, "甲方"), cell("table_2", 0, 1, "乙方"),
      { block_id: "p2", logical_page: 1, block_type: "paragraph", text: "第二条 价款" }
    ];
    const document = { text: "第一条 合同标的\n序号\n项目\n1\nMES 软件\n甲方\n乙方\n第二条 价款", fileVersionId: "t1",
      documentType: "docx", page_status: "estimated", pageCount: 1,
      pages: [{ page: 1, text: "第一条 合同标的" }], blocks };
    const project = { project_id: "table-ui", file_version_id: "t1" };
    store.state.projects = [project];
    store.state.activeProjectId = "table-ui";
    store.state.reviews = { "table-ui": { project, document, risks: [] } };
    const html = await renderToString(createSSRApp(Workspace).use(pinia));
    // 两张独立的表，各自有行列结构
    assert.equal((html.match(/class="document-table"/g) || []).length, 2);
    assert.equal((html.match(/data-table-id="table_1"/g) || []).length, 1);
    assert.equal((html.match(/data-table-id="table_2"/g) || []).length, 1);
    // 同一行的单元格必须落在同一个 <tr> 内
    const firstTable = html.slice(html.indexOf('data-table-id="table_1"'), html.indexOf('data-table-id="table_2"'));
    const rows = firstTable.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes("序号") && rows[0].includes("项目"));
    assert.ok(rows[1].includes("MES 软件"));
    // 段落仍在表格之外按顺序渲染
    assert.ok(html.includes("第一条 合同标的"));
    assert.ok(html.includes("第二条 价款"));
  } finally {
    await server.close();
  }
});

