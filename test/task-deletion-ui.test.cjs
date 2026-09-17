const test = require("node:test");
const assert = require("node:assert/strict");

test("任务列表与删除状态回归", async (t) => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { createPinia, setActivePinia } = await import("pinia");
  const { renderToString } = await import("@vue/server-renderer");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const browserData = new Map();
  const previousWindow = global.window;
  global.window = { setTimeout() {}, localStorage: { getItem: (key) => browserData.get(key), setItem: (key, value) => browserData.set(key, value) } };
  try {
    const { default: Dashboard } = await server.ssrLoadModule("/src/components/DashboardView.vue");
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    const { electronApi } = await server.ssrLoadModule("/src/services/electronApi.js");
    const { deleteReviewTask } = await server.ssrLoadModule("/src/services/reviewTasks.mjs");
    function setup() {
      browserData.clear();
      const pinia = createPinia();
      setActivePinia(pinia);
      const store = useReviewStore();
      store.isReady = true;
      const projects = [
        { project_id: "one", project_name: "First real task", file_version_id: "version-one" },
        { project_id: "two", project_name: "Second real task", file_version_id: "version-two" }
      ];
      store.state = {
        activeProjectId: "one", projects,
        reviews: Object.fromEntries(projects.map((project) => [project.project_id, { project, task: { status: "completed", progress: 100 }, risks: [] }])),
        auditRecords: []
      };
      return { store, pinia };
    }

    await t.test("列表只显示真实项目，每行绑定自己的文件版本和删除入口", async () => {
      const { store, pinia } = setup();
      const html = await renderToString(createSSRApp(Dashboard).use(pinia));
      assert.ok(html.includes("First real task") && html.includes("Second real task"));
      assert.ok(html.includes("version-one") && html.includes("version-two"));
      assert.equal((html.match(/aria-label="删除审查任务：/g) || []).length, 2);
      for (const fake of ["湖畔办公房屋租赁合同", "云启 SaaS 软件开发合同", "智联供应商服务合同"]) assert.equal(html.includes(fake), false);
      store.state.projects = [];
      store.state.reviews = {};
      const empty = await renderToString(createSSRApp(Dashboard).use(pinia));
      assert.ok(empty.includes("暂无审查任务"));
      assert.equal((empty.match(/class="stat-number"[^>]*>0<small\b/g) || []).length, 4);
    });

    await t.test("选择对应任务后清空旧定位，删除非当前任务保持当前视图", async () => {
      const { store } = setup();
      store.activeRiskId = "old-risk";
      store.selectedPage = 9;
      store.validatorResult = { canExport: true };
      store.chatStreamText = "old-answer";
      await store.selectProject("two");
      assert.equal(store.activeProject.project_id, "two");
      assert.equal(store.review.project.project_id, "two");
      assert.equal(store.activeRiskId, null);
      assert.equal(store.selectedPage, 1);
      assert.equal(store.validatorResult, null);
      assert.equal(store.chatStreamText, "");
      store.selectedPage = 3;
      await store.deleteReviewTask("one");
      assert.equal(store.activeProject.project_id, "two");
      assert.equal(store.selectedPage, 3);
    });

    await t.test("删除当前任务自动切换，最后一个任务删除后刷新不会生成示例任务", async () => {
      const { store, pinia } = setup();
      const stale = JSON.parse(JSON.stringify(store.state));
      await electronApi.saveState(store.state);
      store.selectedPage = 8;
      await store.deleteReviewTask("one");
      assert.equal(store.activeProject.project_id, "two");
      assert.equal(store.selectedPage, 1);
      await store.deleteReviewTask("two");
      assert.equal(store.activeProject, null);
      assert.equal(store.review, null);
      const saved = await electronApi.saveState(stale);
      assert.deepEqual(saved.projects, []);
      assert.deepEqual(saved.reviews, {});
      await store.bootstrap();
      assert.equal(store.activeProject, null);
      assert.equal(store.state.projects.length, 0);
      assert.ok((await renderToString(createSSRApp(Dashboard).use(pinia))).includes("暂无审查任务"));
    });

    await t.test("保存或删除失败时保留原状态，任务处理期间不能切换或删除", async (context) => {
      const { store } = setup();
      const initial = JSON.stringify(store.state);
      const saveMock = context.mock.method(electronApi, "saveState", async () => { throw new Error("test save failure"); });
      await assert.rejects(store.selectProject("two"), /test save failure/);
      assert.equal(JSON.stringify(store.state), initial);
      saveMock.mock.restore();
      let requests = 0;
      context.mock.method(electronApi, "deleteReviewTask", async () => { requests += 1; throw new Error("test delete failure"); });
      await assert.rejects(store.deleteReviewTask("one"), /test delete failure/);
      assert.equal(JSON.stringify(store.state), initial);
      assert.equal(store.isBusy, false);
      assert.equal(store.toasts.length, 0);
      store.chatBusy = true;
      await assert.rejects(store.deleteReviewTask("one"), /正在处理/);
      await assert.rejects(store.selectProject("two"), /正在处理/);
      store.chatBusy = false;
      store.isBusy = true;
      await assert.rejects(store.deleteReviewTask("one"), /正在处理/);
      assert.equal(requests, 1);
    });

    await t.test("删除请求完成前不移除行，重复点击不提交第二次删除", async (context) => {
      const { store } = setup();
      let finish;
      context.mock.method(electronApi, "deleteReviewTask", () => new Promise((resolve) => { finish = () => resolve(deleteReviewTask(store.state, "one")); }));
      const pending = store.deleteReviewTask("one");
      assert.equal(store.state.projects.length, 2);
      assert.equal(store.isBusy, true);
      await assert.rejects(store.deleteReviewTask("one"), /正在处理/);
      finish();
      await pending;
      assert.equal(store.state.projects.length, 1);
      assert.equal(store.isBusy, false);
    });
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    await server.close();
  }
});
