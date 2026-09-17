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
    assert.ok(workspace.includes("物理页码待确认"));
  } finally {
    await server.close();
  }
});
