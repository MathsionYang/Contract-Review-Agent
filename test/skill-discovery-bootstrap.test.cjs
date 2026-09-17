const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// 引导阶段必须按磁盘扫描 Skill，而不是沿用能力配置里遗留的名单。
// 回归：界面曾显示"已启用 Skill 3 · contract-common-review · procurement-contract-review ·
// selected-text-review"——这三个名字在 skills/ 目录里根本不存在，也从未被执行过，
// 它们只是首次启动时播种进 state.capabilities 的示例配置，因为引导阶段从不扫描磁盘而一直留着。

test("引导阶段按磁盘扫描 Skill，不沿用能力配置里遗留的名单", async () => {
  const { createServer } = await import("vite");
  const { createPinia, setActivePinia } = await import("pinia");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const previousWindow = globalThis.window;
  try {
    // 已持久化的状态里带着那三个早已不存在的示例 Skill。
    const legacySkills = [
      { name: "contract-common-review", version: "1.3.0", scope: "全部合同", status: "enabled" },
      { name: "procurement-contract-review", version: "1.2.0", scope: "采购合同", status: "enabled" },
      { name: "selected-text-review", version: "1.0.0", scope: "全部合同", status: "enabled" }
    ];
    // 磁盘扫描的真实结果：只有 skills/ 下真实存在、且声明了条款抽取的那个 Skill。
    const discovered = [{ name: "contract-clause-extractor", version: "", description: "按原文顺序抽取全部条款",
      directory: "skills/contract-clause-extractor", declares_blocks: true }];
    const persisted = [];
    globalThis.window = { contractApp: {
      loadState: async () => ({ projects: [], capabilities: { models: [], skills: legacySkills }, settings: {}, knowledge: {} }),
      saveState: async (next) => { persisted.push(next); return next; },
      clauseSkillStatus: async () => ({ available: true, reason: "ok", discovered,
        skill: { name: "contract-clause-extractor", version: "", directory: "skills/contract-clause-extractor" } }),
      onReviewProgress: () => () => {},
      onChatEvent: () => () => {}
    } };
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    setActivePinia(createPinia());
    const store = useReviewStore();
    await store.bootstrap();

    const names = (store.state.capabilities?.skills || []).map((skill) => skill.name);
    assert.deepEqual(names, ["contract-clause-extractor"], "能力配置必须只有磁盘上真实存在的 Skill");
    for (const legacy of legacySkills) {
      assert.ok(!names.includes(legacy.name), `已不存在的示例 Skill ${legacy.name} 不得继续出现`);
    }
    // 执行快照（界面"已启用 Skill"数据源）必须来自真实扫描结果
    const execution = store.reviewExecution;
    assert.deepEqual((execution.skills || []).map((skill) => skill.name), ["contract-clause-extractor"]);
    // 纠正后的名单必须写回磁盘，否则每次启动都要重新迁移一遍
    const written = (persisted.at(-1)?.capabilities?.skills || []).map((skill) => skill.name);
    assert.deepEqual(written, ["contract-clause-extractor"], "磁盘上的残留名单必须被就地纠正");
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    await server.close();
  }
});

test("扫描不到 Skill 时不保留历史名单，也不伪造版本号", async () => {
  const { createServer } = await import("vite");
  const { createPinia, setActivePinia } = await import("pinia");
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { contractApp: {
      loadState: async () => ({ projects: [], capabilities: { models: [], skills: [
        { name: "contract-common-review", version: "1.3.0", scope: "全部合同", status: "enabled" }] }, settings: {}, knowledge: {} }),
      saveState: async (next) => next,
      // 目录被清空：如实报告"未发现"，不能退回过期名单
      clauseSkillStatus: async () => ({ available: false, reason: "skill_not_found", message: "未发现可用的条款抽取 Skill", discovered: [] }),
      onReviewProgress: () => () => {},
      onChatEvent: () => () => {}
    } };
    const { useReviewStore } = await server.ssrLoadModule("/src/stores/review.js");
    setActivePinia(createPinia());
    const store = useReviewStore();
    await store.bootstrap();
    assert.deepEqual(store.state.capabilities?.skills, [], "扫描为空时不得保留历史 Skill");
    assert.deepEqual(store.reviewExecution.skills, []);
    // 没有声明版本的 Skill 不应被填上"未标注"这类假版本号
    const source = fs.readFileSync(path.resolve(__dirname, "../src/stores/review.js"), "utf8");
    assert.ok(!source.includes('"未标注"'), "不得伪造 Skill 版本号");
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    await server.close();
  }
});
