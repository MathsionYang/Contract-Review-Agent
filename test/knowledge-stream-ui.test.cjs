const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("知识库与流式风险的组件和状态回归", async (t) => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const data = new Map();
  const previousWindow = global.window;
  global.window = { setTimeout() {}, location: { search: "" }, localStorage: { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) } };
  try {
    const { default: Knowledge } = await server.ssrLoadModule("/src/components/KnowledgeView.vue");
    const { default: Workspace } = await server.ssrLoadModule("/src/components/ReviewWorkspace.vue");
    const { default: Dashboard } = await server.ssrLoadModule("/src/components/DashboardView.vue");
    const { default: Capability } = await server.ssrLoadModule("/src/components/CapabilityView.vue");
    const { default: ModelActivity } = await server.ssrLoadModule("/src/components/ReviewModelActivity.vue");
    const { default: App } = await server.ssrLoadModule("/src/App.vue");
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    const { electronApi } = await server.ssrLoadModule("/src/services/electronApi.js");
    const { knowledgeItemKey } = await server.ssrLoadModule("/src/services/knowledgeManagement.mjs");
    async function setup() {
      data.clear();
      const pinia = createPinia();
      setActivePinia(pinia);
      const store = useReviewStore();
      const project = { project_id: "p", file_version_id: "v1", project_name: "test contract", contract_type: "procurement" };
      store.state.projects = [project];
      store.state.activeProjectId = "p";
      store.state.reviews = { p: { project, config: {}, document: { text: "测试合同", pages: [{ page: 1, text: "测试合同" }] }, risks: [], task: { status: "completed", progress: 100 } } };
      store.state.knowledge = { legalSnapshots: [{ id: "s1", name: "测试快照", status: "draft", coverage: "test" }], rules: [{ file: "rule.txt", selected: true }], policies: [{ file: "policy.txt" }], memory: [{ content: "memory test", status: "正式" }] };
      store.state.auditRecords = [{ audit_id: "a1", action: "测试导入", created_at: "2026-09-17T00:00:00Z" }];
      await electronApi.saveState(store.state);
      return { pinia, store };
    }
    async function renderKnowledge(pinia, tab) {
      let controls;
      const component = { ...Knowledge, setup(props, context) {
        controls = Knowledge.setup(props, context);
        controls.setActiveTab(tab);
        return controls;
      } };
      return { html: await renderToString(createSSRApp(component).use(pinia)), controls };
    }

    await t.test("每个页签显示删除入口，快照空列表不会回退到示例数据", async () => {
      const { store, pinia } = await setup();
      for (const [tab, label] of [["snapshots", "删除法律快照 测试快照"], ["rules", "删除 rule.txt"], ["policies", "删除 policy.txt"], ["memory", "删除企业记忆 memory test"], ["audit", "删除审计记录 测试导入"]]) {
        const { html } = await renderKnowledge(pinia, tab);
        assert.ok(html.includes(`aria-label="${label}"`), tab);
      }
      store.state.knowledge.legalSnapshots = [];
      const { html } = await renderKnowledge(pinia, "snapshots");
      assert.ok(html.includes("没有匹配的法律快照"));
      assert.equal(html.includes("CN-2026-09"), false);
    });

    await t.test("草稿可显式发布并绑定，确认前不生效且刷新保留结果", async () => {
      const { store, pinia } = await setup();
      store.state.knowledge.legalSnapshots[0].clauses = [{ text: "测试法律条款" }];
      store.state.knowledge.legalSnapshots[0].coverage = "待填写";
      const { controls, html } = await renderKnowledge(pinia, "snapshots");
      assert.ok(html.includes('aria-label="发布法律快照 测试快照"'));
      assert.ok(html.includes("草稿 · 待发布"));
      assert.equal(html.includes("校验中"), false);
      controls.openSnapshotEdit(store.state.knowledge.legalSnapshots[0], true);
      assert.equal(controls.snapshotForm.coverage, "");
      assert.equal(controls.snapshotSubmitLabel.value, "发布并绑定");
      controls.snapshotForm.coverage = "设备采购；交付、质量检验、价款支付";
      await controls.submitSnapshotForm();
      assert.equal(controls.snapshotEditOpen.value, true);
      assert.equal(store.state.knowledge.legalSnapshots[0].status, "draft");
      assert.equal(store.review.config.snapshot, undefined);
      controls.publicationConfirmed.value = true;
      await controls.submitSnapshotForm();
      assert.equal(controls.snapshotEditOpen.value, false);
      assert.equal(store.state.knowledge.legalSnapshots[0].status, "published");
      assert.deepEqual(store.review.config.snapshot, { id: "s1", status: "published" });
      assert.ok(Number.isFinite(Date.parse(store.state.knowledge.legalSnapshots[0].publishedAt)));
      assert.equal(store.state.knowledge.legalSnapshots[0].realtime_verification, undefined);
      assert.equal(store.state.auditRecords[0].action, "发布法律快照");
      await store.bootstrap();
      assert.equal(store.review.config.snapshot.id, "s1");
      assert.equal(controls.boundSnapshotLabel.value, "测试快照");
    });

    await t.test("发布失败不改变快照和绑定，不会提示发布成功", async (context) => {
      const { store, pinia } = await setup();
      store.state.knowledge.legalSnapshots[0].clauses = [{ text: "正文" }];
      const { controls } = await renderKnowledge(pinia, "snapshots");
      controls.openSnapshotEdit(store.state.knowledge.legalSnapshots[0], true);
      controls.publicationConfirmed.value = true;
      const before = JSON.stringify(store.state);
      context.mock.method(electronApi, "saveState", async () => { throw new Error("snapshot save failed"); });
      await controls.submitSnapshotForm();
      assert.equal(JSON.stringify(store.state), before);
      assert.equal(store.isBusy, false);
      assert.equal(controls.snapshotEditOpen.value, true);
      assert.ok(store.toasts.some((toast) => toast.message === "snapshot save failed"));
      assert.equal(store.toasts.some((toast) => toast.message.includes("已发布")), false);
    });

    await t.test("没有任务仍可发布，但不能伪造绑定或绑定历史、撤销快照", async (context) => {
      const { store, pinia } = await setup();
      for (const status of ["draft", "historical", "revoked"]) {
        store.state.knowledge.legalSnapshots[0].status = status;
        await assert.rejects(store.saveConfig({ snapshot: { id: "s1", status: "published" } }), /只能绑定已发布/);
      }
      store.state.knowledge.legalSnapshots[0].status = "published";
      const before = JSON.stringify(store.state);
      const saveMock = context.mock.method(electronApi, "saveState", async () => { throw new Error("binding failed"); });
      await assert.rejects(store.saveConfig({ snapshot: { id: "s1", status: "published" } }), /binding failed/);
      assert.equal(JSON.stringify(store.state), before);
      assert.equal(store.isBusy, false);
      saveMock.mock.restore();
      store.state.knowledge.legalSnapshots[0].status = "draft";
      store.state.knowledge.legalSnapshots[0].clauses = [{ text: "正文" }];
      store.state.projects = [];
      store.state.reviews = {};
      store.state.activeProjectId = null;
      await store.toggleKnowledge("rules", 0);
      assert.equal((await electronApi.loadState()).knowledge.rules[0].selected, false);
      const { controls } = await renderKnowledge(pinia, "snapshots");
      assert.equal(controls.boundSnapshotLabel.value, "未选择审查任务");
      controls.openSnapshotEdit(store.state.knowledge.legalSnapshots[0], true);
      assert.equal(controls.snapshotSubmitLabel.value, "发布快照");
      controls.publicationConfirmed.value = true;
      await controls.submitSnapshotForm();
      assert.equal(store.state.knowledge.legalSnapshots[0].status, "published");
      await assert.rejects(store.saveConfig({ snapshot: { id: "s1" } }), /先选择/);
    });

    await t.test("审查配置显示真实发布状态，可直接跳转快照管理，已发布版本可保存绑定", async () => {
      const { store, pinia } = await setup();
      let controls;
      async function renderConfig() {
        const component = { ...App, setup(props, context) {
          controls = App.setup(props, context);
          controls.openConfig();
          return controls;
        } };
        const context = {};
        await renderToString(createSSRApp(component).use(pinia), context);
        return context.teleports.body;
      }
      const draft = await renderConfig();
      assert.ok(draft.includes("草稿 · 待发布") && draft.includes("暂无已发布的法律快照"));
      assert.equal(draft.includes("校验中"), false);
      controls.manageSnapshots();
      assert.equal(controls.modal.value, null);
      assert.equal(controls.activeView.value, "knowledge");
      assert.equal(controls.knowledgeTab.value, "snapshots");
      store.state.knowledge.legalSnapshots[0].status = "published";
      const published = await renderConfig();
      assert.ok(published.includes("已发布") && !published.includes("暂无已发布"));
      assert.equal(controls.configForm.snapshotId, "s1");
      await controls.saveConfig();
      assert.equal(store.review.config.snapshot.id, "s1");
      assert.equal(controls.modal.value, null);
      store.isBusy = true;
      await assert.rejects(store.updateLegalSnapshot("s1", { name: "new" }), /正在处理/);
    });

    await t.test("删除弹窗锁定原页签目标，成功后持久化，失败不移除条目", async (context) => {
      const { store, pinia } = await setup();
      const { controls } = await renderKnowledge(pinia, "snapshots");
      controls.askDeleteOne(store.state.knowledge.legalSnapshots[0]);
      controls.setActiveTab("memory");
      assert.equal(controls.deleteOpen.value, true);
      await controls.confirmDelete();
      assert.equal(controls.deleteOpen.value, false);
      assert.equal(store.state.knowledge.legalSnapshots.length, 0);
      assert.equal(store.state.knowledge.memory.length, 1);
      await store.bootstrap();
      assert.equal(store.state.knowledge.legalSnapshots.length, 0);
      controls.askDeleteOne(store.state.knowledge.memory[0]);
      context.mock.method(electronApi, "deleteKnowledge", async () => { throw new Error("disk failure"); });
      const before = JSON.stringify(store.state);
      await controls.confirmDelete();
      assert.equal(JSON.stringify(store.state), before);
      assert.equal(controls.deleteOpen.value, true);
      assert.equal(store.isBusy, false);
      assert.ok(store.toasts.some((toast) => toast.message === "disk failure"));
    });

    await t.test("取消快照导入不覆盖现有状态，重复删除与处理期间删除被拦截", async (context) => {
      const { store } = await setup();
      const initial = JSON.stringify(store.state);
      context.mock.method(electronApi, "importLegalSnapshot", async () => ({ canceled: true, state: {} }));
      await store.importLegalSnapshot();
      assert.equal(JSON.stringify(store.state), initial);
      const keys = [knowledgeItemKey("memory", store.state.knowledge.memory[0])];
      let finish;
      context.mock.method(electronApi, "deleteKnowledge", () => new Promise((resolve) => { finish = () => resolve(store.state); }));
      const pending = store.deleteKnowledge("memory", keys);
      await assert.rejects(store.deleteKnowledge("memory", keys), /正在处理/);
      finish();
      await pending;
      store.chatBusy = true;
      await assert.rejects(store.deleteKnowledge("memory", keys), /正在处理/);
    });

    await t.test("风险在审查 Promise 返回前进入清单，旧事件不能覆盖最终状态", async (context) => {
      const { store, pinia } = await setup();
      let progress;
      context.mock.method(electronApi, "onReviewProgress", (callback) => { progress = callback; return () => {}; });
      await store.bootstrap();
      let request;
      let finish;
      context.mock.method(electronApi, "runReview", (payload) => { request = payload; return new Promise((resolve) => { finish = resolve; }); });
      const pending = store.runReview();
      const event = { runId: request.runId, projectId: "p", fileVersionId: "v1", sequence: 1, step: "rules", status: "running", riskUpdate: { type: "reset" } };
      progress(event);
      const risk = { risk_id: "r1", title: "实时新风险", human_status: "pending_review", contract_location: { file_version_id: "v1", page: 1, quote: "测试合同" } };
      progress({ ...event, sequence: 2, step: "model", progress: 70, riskUpdate: { type: "upsert", risk } });
      assert.equal(store.risks.length, 1);
      assert.equal(store.isBusy, true);
      await store.applyRiskAction("r1", "accepted");
      assert.equal(store.risks[0].human_status, "pending_review");
      const html = await renderToString(createSSRApp(Workspace).use(pinia));
      assert.ok(html.includes("最新识别：实时新风险"));
      assert.ok(html.includes("当前已识别 1 条候选风险"));
      assert.match(html, /aria-label="接受风险" disabled/);
      const finalReview = JSON.parse(JSON.stringify(store.review));
      finalReview.task = { status: "partial", progress: 100, current_step: "persist", errors: [{ code: "CRITICAL_CHECKS_INCOMPLETE", message: "1 项未完成", details: [{ check_id: "amount.total_vs_uppercase", message: "未能提取总价" }], suggestion: "核对合同原文" }] };
      finish({ review: finalReview });
      await pending;
      progress({ ...event, sequence: 999 });
      assert.equal(store.risks.length, 1);
      assert.equal(store.review.task.status, "partial");
      const completed = await renderToString(createSSRApp(Workspace).use(pinia));
      assert.ok(completed.includes("amount.total_vs_uppercase") && completed.includes("核对合同原文"));
    });

    await t.test("抽取消息显示真实批次、数量与原文，完成可展开且异常不持续转圈", async () => {
      const summary = { status: "running", phase: "requesting", model_name: "extract", current_batch: 2, total_batches: 3, completed_batches: 1,
        baseline_fact_count: 8, accepted_fact_count: 2, total_fact_count: 10, duplicate_fact_count: 1, rejected_fact_count: 1,
        current_source: { logical_page: 1, quote: "第二批原文" }, recent_facts: [{ fact_id: "f", fact_type: "ratio", clause_no: "2.3", quote: "百分之三十<script>" }] };
      const running = await renderToString(createSSRApp(ModelActivity, { summary, active: true }));
      assert.ok(running.includes('aria-label="条款抽取过程"'));
      assert.ok(running.includes("第 2 / 3 批"));
      assert.ok(running.includes("1/3 批 · 33%"));
      assert.ok(running.includes("逻辑页 1"));
      assert.ok(running.includes("第二批原文"));
      assert.ok(running.includes("百分之三十&lt;script&gt;"));
      assert.ok(running.includes("模型新增 <b>2</b>"));
      assert.ok(running.includes("合计 <b>10</b>"));
      assert.ok(running.includes("已去重 1 条 · 未通过校验 1 条"));
      const interrupted = await renderToString(createSSRApp(ModelActivity, { summary, active: false }));
      assert.ok(interrupted.includes("抽取已中断"));
      assert.equal(interrupted.includes('class="spin"'), false);
      const degraded = await renderToString(createSSRApp(ModelActivity, { summary: { ...summary, status: "degraded", message: "连接超时" } }));
      assert.ok(degraded.includes("已降级") && degraded.includes("连接超时"));
      const completed = { ...summary, status: "completed", phase: "finished", completed_batches: 3 };
      const collapsed = await renderToString(createSSRApp(ModelActivity, { summary: completed }));
      assert.ok(collapsed.includes('aria-label="展开条款抽取详情"'));
      assert.equal(collapsed.includes("百分之三十"), false);
      const expandedComponent = { ...ModelActivity, setup(props, context) { const controls = ModelActivity.setup(props, context); controls.expanded.value = true; return controls; } };
      const expanded = await renderToString(createSSRApp(expandedComponent, { summary: completed }));
      assert.ok(expanded.includes("百分之三十"));
      assert.ok(expanded.includes("3/3 批 · 100%"));
    });

    await t.test("语义分析消息区分等待、接收、完成和失败，不伪造完成百分比", async () => {
      const summary = { status: "running", phase: "requesting", model_name: "analysis", received_risk_count: 0, context: { page_count: 3, included_fact_count: 10, included_evidence_count: 2, truncated_pages: [3] } };
      const waiting = await renderToString(createSSRApp(ModelActivity, { role: "analysis", summary, active: true }));
      assert.ok(waiting.includes("等待模型返回"));
      assert.ok(waiting.includes("1 页原文有删节"));
      assert.equal(waiting.includes("<progress"), false);
      const receiving = await renderToString(createSSRApp(ModelActivity, { role: "analysis", active: true, summary: { ...summary, phase: "receiving", received_risk_count: 1,
        recent_risks: [{ risk_id: "r", title: "新识别风险", location_status: "unresolved", quote: "" }] } }));
      assert.ok(receiving.includes("已识别 1 条候选"));
      assert.ok(receiving.includes("新识别风险") && receiving.includes("原文待定位"));
      for (const status of ["completed", "failed", "not_configured"]) {
        const html = await renderToString(createSSRApp(ModelActivity, { role: "analysis", summary: { ...summary, status } }));
        assert.equal(html.includes('class="spin"'), false);
        assert.ok(html.includes(status === "completed" ? "语义分析完成" : status === "failed" ? "语义分析未完成" : "本次仅保留本地检查结果"));
      }
    });

    await t.test("抽取与分析进度进入对话区，历史对话不被改写，旧事件不能替换最新过程", async (context) => {
      const { store, pinia } = await setup();
      store.review.chat_sessions = [{ chat_session_id: "session", status: "active", messages: [{ message_id: "m", role: "user", content: "原来的对话" }] }];
      store.state.capabilities.models = [{ name: "analysis", role: "analysis", status: "active", testStatus: "passed", modelId: "analysis", endpoint: "https://models.invalid" }];
      await electronApi.saveState(store.state);
      let progress;
      context.mock.method(electronApi, "onReviewProgress", (callback) => { progress = callback; return () => {}; });
      await store.bootstrap();
      let request;
      let finish;
      context.mock.method(electronApi, "runReview", (payload) => { request = payload; return new Promise((resolve) => { finish = resolve; }); });
      const pending = store.runReview();
      const extraction = { status: "running", phase: "requesting", model_name: "extract", current_batch: 1, total_batches: 2, completed_batches: 0, baseline_fact_count: 3, recent_facts: [], started_at: "2026-09-17T00:00:00Z" };
      const event = { runId: request.runId, projectId: "p", fileVersionId: "v1", sequence: 1, step: "extract", status: "running",
        riskUpdate: { type: "reset" }, executionSummary: { extraction, analysis: { status: "pending" } } };
      progress(event);
      const first = await renderToString(createSSRApp(Workspace).use(pinia));
      assert.ok(first.indexOf('aria-label="条款抽取过程"') > first.indexOf('aria-label="对话审核"'));
      assert.ok(first.includes("第 1 / 2 批"));
      assert.equal(first.includes('aria-label="语义分析过程"'), false);
      assert.ok(first.includes("原来的对话"));
      const secondEvent = { ...event, sequence: 2, step: "model", riskUpdate: undefined, executionSummary: { extraction: { ...extraction, status: "completed", completed_batches: 2 },
        analysis: { status: "running", phase: "receiving", received_risk_count: 1, recent_risks: [{ risk_id: "r", title: "过程中的新风险" }], started_at: "2026-09-17T00:01:00Z" } } };
      progress(secondEvent);
      const second = await renderToString(createSSRApp(Workspace).use(pinia));
      assert.ok(second.includes('aria-label="语义分析过程"') && second.includes("过程中的新风险"));
      assert.ok(second.indexOf('aria-label="语义分析过程"') < second.indexOf('aria-label="条款抽取过程"'));
      assert.equal(store.chatMessages.length, 1);
      progress({ ...event, sequence: 99, runId: "stale" });
      assert.equal(store.review.execution_summary.analysis.received_risk_count, 1);
      assert.equal(second.includes("模型只会使用已勾选的上下文"), false);
      assert.ok(second.includes("对话上下文：合同信息、最近对话"));
      store.updateChatContextPreferences({ includeKnowledge: false, includeSelection: false });
      const selected = await renderToString(createSSRApp(Workspace).use(pinia));
      const label = selected.match(/title="(对话上下文：[^"]+)"/)[1];
      assert.equal(label.includes("知识依据"), false);
      assert.equal(label.includes("选区"), false);
      const finalReview = JSON.parse(JSON.stringify(store.review));
      finalReview.execution_summary.analysis.status = "completed";
      finalReview.task = { status: "completed", progress: 100, current_step: "persist" };
      finish({ review: finalReview });
      await pending;
      progress({ ...secondEvent, sequence: 100 });
      assert.equal(store.review.execution_summary.analysis.status, "completed");
      assert.equal(store.chatMessages[0].content, "原来的对话");
    });

    await t.test("模型连接测试真实走 IPC，阻止重复请求并区分旧的本地字段校验", async () => {
      const { store, pinia } = await setup();
      store.state.capabilities.models = [{ configId: "model-1", name: "抽取模型", role: "extraction", modelId: "extract", endpoint: "https://models.invalid/v1", status: "active", testStatus: "passed" }];
      await electronApi.saveState(store.state);
      const previousTest = electronApi.testModelConnection;
      try {
        const before = await renderToString(createSSRApp(Capability).use(pinia));
        assert.ok(before.includes("仅字段已校验"));
        assert.ok(before.includes("已启用"));
        assert.equal(before.includes("运行中"), false);
        let finish;
        let calls = 0;
        electronApi.testModelConnection = async ({ configId }) => { calls += 1; assert.equal(configId, "model-1"); return new Promise((resolve) => { finish = resolve; }); };
        const pending = store.validateModel("model-1");
        await new Promise(setImmediate);
        assert.equal(store.isModelTesting("model-1"), true);
        assert.equal(await store.validateModel("model-1"), false);
        assert.equal(calls, 1);
        assert.ok((await renderToString(createSSRApp(Capability).use(pinia))).includes("连接测试中"));
        finish({ ok: true, message: "真实连通性测试通过", testedAt: "2026-09-17T10:00:00Z", latencyMs: 10 });
        assert.equal(await pending, true);
        assert.equal(store.state.capabilities.models[0].testKind, "remote");
        assert.ok((await renderToString(createSSRApp(Capability).use(pinia))).includes("连接已验证"));
        assert.equal((await electronApi.loadState()).capabilities.models[0].testKind, "remote");
        electronApi.testModelConnection = async () => ({ ok: false, message: "HTTP 401" });
        assert.equal(await store.validateModel("model-1"), false);
        assert.equal(store.state.capabilities.models[0].status, "disabled");
        assert.ok((await renderToString(createSSRApp(Capability).use(pinia))).includes("HTTP 401"));
      } finally { electronApi.testModelConnection = previousTest; }
    });

    await t.test("连接测试的过期结果不能覆盖编辑后的模型，保存失败不得显示成功", async () => {
      const { store } = await setup();
      store.state.capabilities.models = [{ configId: "m", name: "模型", role: "analysis", modelId: "old", endpoint: "https://models.invalid", testStatus: "untested" }];
      await electronApi.saveState(store.state);
      const oldTest = electronApi.testModelConnection;
      const oldSave = electronApi.saveState;
      try {
        let finish;
        electronApi.testModelConnection = () => new Promise((resolve) => { finish = resolve; });
        const pending = store.validateModel("m");
        await new Promise(setImmediate);
        await store.saveModel({ ...store.state.capabilities.models[0], modelId: "edited" });
        finish({ ok: true });
        assert.equal(await pending, false);
        assert.equal(store.state.capabilities.models[0].testStatus, "untested");
        electronApi.testModelConnection = async () => { electronApi.saveState = async () => { throw new Error("disk full"); }; return { ok: true, message: "通过" }; };
        await assert.rejects(store.validateModel("m"), /disk full/);
        assert.equal(store.state.capabilities.models[0].testStatus, "untested");
        assert.equal(store.state.capabilities.models[0].status, "disabled");
      } finally { electronApi.testModelConnection = oldTest; electronApi.saveState = oldSave; }
    });

    await t.test("审查和对话忙碌时仍可编辑、测试并启用，模型保存不会覆盖任务记录", async (context) => {
      for (const busy of ["isBusy", "chatBusy"]) {
        const { store, pinia } = await setup();
        const model = await store.saveModel({ name: "抽取模型", role: "extraction", modelId: "old", endpoint: "https://models.invalid" });
        await electronApi.saveState(store.state);
        const execution = JSON.stringify(store.review.config.execution);
        store[busy] = true;
        // Disk may contain newer chat/risk data than the renderer during a request.
        const latest = await electronApi.loadState();
        latest.reviews.p.risks = [{ risk_id: "new-risk" }];
        latest.reviews.p.chat_sessions = [{ messages: [{ content: "new message" }] }];
        latest.auditRecords.unshift({ audit_id: "backend-audit" });
        await electronApi.saveState(latest);
        const preserved = JSON.stringify(latest.reviews);
        await store.saveModel({ ...model, modelId: "edited" });
        const before = await renderToString(createSSRApp(Capability).use(pinia));
        assert.doesNotMatch(before.match(/<button[^>]*aria-label="测试 抽取模型 连接"[^>]*>/)[0], /disabled/);
        let finish;
        context.mock.method(electronApi, "testModelConnection", () => new Promise((resolve) => { finish = resolve; }));
        const testing = store.validateModel(model.configId);
        const during = await renderToString(createSSRApp(Capability).use(pinia));
        assert.match(during.match(/<button[^>]*aria-label="测试 抽取模型 连接"[^>]*>/)[0], /disabled/);
        // A review/chat response replaces state while the independent test runs.
        store.state = await electronApi.loadState();
        assert.equal(store.isModelTesting(model.configId), true);
        assert.equal(await store.validateModel(model.configId), false);
        finish({ ok: true, message: "连接测试通过" });
        assert.equal(await testing, true);
        assert.equal(store.isModelTesting(model.configId), false);
        assert.equal(await store.toggleModel(model.configId), true);
        assert.equal(store.state.capabilities.models[0].status, "active");
        const saved = await electronApi.loadState();
        assert.equal(saved.capabilities.models[0].status, "active");
        assert.equal(JSON.stringify(saved.reviews), preserved);
        assert.equal(JSON.stringify(store.review.config.execution), execution);
        assert.ok(saved.auditRecords.some((entry) => entry.audit_id === "backend-audit"));
        assert.equal(store[busy], true);
      }
    });

    await t.test("不同模型独立测试，旧配置回包不能释放新配置的测试锁", async (context) => {
      const { store, pinia } = await setup();
      const first = await store.saveModel({ name: "模型一", role: "analysis", modelId: "one", endpoint: "https://models.invalid" });
      const second = await store.saveModel({ name: "模型二", role: "extraction", modelId: "two", endpoint: "https://models.invalid" });
      const requests = [];
      context.mock.method(electronApi, "testModelConnection", ({ configId }) => new Promise((resolve) => { requests.push({ configId, resolve }); }));
      const oldTest = store.validateModel(first.configId);
      const html = await renderToString(createSSRApp(Capability).use(pinia));
      assert.doesNotMatch(html.match(/<button[^>]*aria-label="测试 模型二 连接"[^>]*>/)[0], /disabled/);
      const secondTest = store.validateModel(second.configId);
      await store.saveModel({ ...first, modelId: "edited" });
      const newTest = store.validateModel(first.configId);
      requests[0].resolve({ ok: true });
      assert.equal(await oldTest, false);
      assert.equal(store.isModelTesting(first.configId), true);
      requests[1].resolve({ ok: false, message: "HTTP 401" });
      assert.equal(await secondTest, false);
      assert.equal(store.isModelTesting(first.configId), true);
      requests[2].resolve({ ok: true });
      assert.equal(await newTest, true);
      assert.equal(store.state.capabilities.models.find((model) => model.configId === first.configId).modelId, "edited");
      assert.equal(store.state.capabilities.models.find((model) => model.configId === second.configId).testStatus, "failed");
      const deletedTest = store.validateModel(first.configId);
      await store.deleteModel(first.configId);
      requests[3].resolve({ ok: true });
      assert.equal(await deletedTest, false);
      assert.equal((await electronApi.loadState()).capabilities.models.length, 1);
    });

    await t.test("模型保存、启用和删除失败不改变本地配置，也不提示成功", async (context) => {
      const { store } = await setup();
      const model = await store.saveModel({ name: "模型", role: "analysis", modelId: "one", endpoint: "https://models.invalid" });
      context.mock.method(electronApi, "testModelConnection", async () => ({ ok: true }));
      await store.validateModel(model.configId);
      store.toasts = [];
      const before = JSON.stringify(store.state);
      context.mock.method(electronApi, "updateModel", async () => { throw new Error("disk full"); });
      await assert.rejects(store.saveModel({ ...model, modelId: "edited" }), /disk full/);
      await assert.rejects(store.toggleModel(model.configId), /disk full/);
      await assert.rejects(store.deleteModel(model.configId), /disk full/);
      assert.equal(JSON.stringify(store.state), before);
      assert.equal(store.toasts.length, 0);
    });

    await t.test("模型在审查中修改只影响下次执行，不改写当前执行快照", async (context) => {
      const { store } = await setup();
      const model = await store.saveModel({ name: "模型", role: "analysis", modelId: "old", endpoint: "https://models.invalid" });
      context.mock.method(electronApi, "testModelConnection", async () => ({ ok: true }));
      await store.validateModel(model.configId);
      await store.toggleModel(model.configId);
      let finish;
      let submitted;
      context.mock.method(electronApi, "runReview", ({ review }) => {
        submitted = JSON.parse(JSON.stringify(review));
        return new Promise((resolve) => { finish = async () => {
          const saved = await electronApi.loadState();
          saved.reviews.p = submitted;
          await electronApi.saveState(saved);
          resolve({ review: submitted, state: saved });
        }; });
      });
      const running = store.runReview();
      await store.saveModel({ ...model, modelId: "edited" });
      await store.validateModel(model.configId);
      await store.toggleModel(model.configId);
      assert.equal(store.review.config.execution.models.analysis.modelId, "old");
      await finish();
      await running;
      assert.equal(store.state.capabilities.models[0].modelId, "edited");
      assert.equal(store.state.capabilities.models[0].status, "active");
      assert.equal(store.review.config.execution.models.analysis.modelId, "old");
      const nextRun = store.runReview();
      assert.equal(submitted.config.execution.models.analysis.modelId, "edited");
      await finish();
      await nextRun;
    });

    await t.test("执行面板显示实际调用与降级，不将已配置重排模型显示为已执行", async () => {
      const { store, pinia } = await setup();
      store.review.execution_summary = {
        extraction: { model_name: "extract", status: "completed", call_count: 2, accepted_fact_count: 3, rejected_fact_count: 0 },
        embedding: { model_name: "vector", status: "degraded", call_count: 1, fallback: "keyword", chunk_count: 5, cache_hit_count: 0 },
        rerank: { status: "not_integrated", call_count: 0 }
      };
      const component = { ...Workspace, setup(props, context) { const controls = Workspace.setup(props, context); controls.executionPanelOpen.value = true; return controls; } };
      const html = await renderToString(createSSRApp(component).use(pinia));
      assert.ok(html.includes("已完成 · 2 次调用"));
      assert.ok(html.includes("已降级 · 1 次调用 · 关键词检索"));
      assert.ok(html.includes("尚未接入执行 · 0 次调用"));
      assert.ok(html.includes("模型新增 3 条事实"));
    });

    await t.test("首页徽标保持一行文字和稳定的横向尺寸", async () => {
      const { pinia } = await setup();
      const html = await renderToString(createSSRApp(Dashboard).use(pinia));
      assert.match(html, /<span\b[^>]*>证据可追溯<\/span>/);
      assert.equal(html.includes("证据<br"), false);
      const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
      assert.match(css, /\.hero-seal \{[^}]*width: 144px; height: 44px;/);
      assert.match(css, /\.hero-seal span \{ white-space: nowrap; \}/);
    });
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    await server.close();
  }
});
