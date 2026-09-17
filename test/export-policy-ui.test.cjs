const test = require("node:test");
const assert = require("node:assert/strict");

test("导出界面区分草稿警告与正式阻断，store 完整传递模式", async () => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const previousWindow = global.window;
  global.window = { setTimeout() {} };
  try {
    const { default: ExportValidation } = await server.ssrLoadModule("/src/components/ExportValidation.vue");
    const issue = { id: "pending", label: "高风险复核", code: "PENDING_HUMAN_REVIEW", status: "warning", message: "待确认", suggestion: "核实后接受或驳回", riskId: "risk-1" };
    const draft = await renderToString(createSSRApp(ExportValidation, { validation: { mode: "draft", canExport: true, items: [issue] } }));
    assert.ok(draft.includes("可导出草稿，1 项待核验"));
    assert.ok(draft.includes("不得作为正式审查结论"));
    assert.ok(draft.includes("risk-1") && draft.includes("核实后接受或驳回"));
    const formal = await renderToString(createSSRApp(ExportValidation, { validation: { mode: "formal", canExport: false, items: [{ ...issue, status: "failed" }] } }));
    assert.ok(formal.includes("存在阻断项，暂不可导出"));
    assert.ok(formal.includes("阻断 · 高风险复核"));
    assert.equal(formal.includes("可导出草稿"), false);
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    const { electronApi } = await server.ssrLoadModule("/src/services/electronApi.js");
    setActivePinia(createPinia());
    const store = useReviewStore();
    assert.equal(store.state.settings.defaultExportMode, "draft");
    const calls = [];
    electronApi.validateExport = async (payload) => { calls.push(payload); return { mode: payload.mode, canExport: payload.mode === "draft" }; };
    electronApi.exportReview = async (payload) => { calls.push(payload); return { records: [{ format: "JSON", export_mode: payload.mode }], validation: { mode: payload.mode, canExport: true } }; };
    await store.runValidator(["JSON"], "draft");
    await store.runExport(["JSON"], "draft");
    await store.runValidator(["JSON"], "formal");
    assert.deepEqual(calls.map((call) => call.mode), ["draft", "draft", "formal"]);
    assert.ok(calls.every((call) => call.review && call.formats[0] === "JSON"));
    assert.equal(store.validatorResult.mode, "formal");
    assert.equal(store.validatorResult.canExport, false);
    store.chatBusy = true;
    await assert.rejects(store.runExport(["JSON"], "draft"), /正在处理/);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    await server.close();
  }
});
