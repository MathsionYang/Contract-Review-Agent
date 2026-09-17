const test = require("node:test");
const assert = require("node:assert/strict");

// 红灯阶段允许模块尚未实现，但失败必须落在行为断言上。
const managementStatePromise = import("../src/services/managementState.mjs").catch(() => ({}));

test("新增知识项会按规则库类型补齐默认字段", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.createKnowledgeItem, "function");

  const item = managementState.createKnowledgeItem("rules", {
    file: "amount-check@1.0",
    summary: "校验金额和比例",
    type: "金额计算"
  });

  assert.equal(item.file, "amount-check@1.0");
  assert.equal(item.summary, "校验金额和比例");
  assert.equal(item.selected, false);
  assert.equal(item.status, "active");
  assert.equal(item.priority, "high");
});

test("删除知识项只移除指定文件并保留其他项", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.removeKnowledgeItems, "function");

  const items = [
    { file: "a@1.0" },
    { file: "b@1.0" },
    { file: "c@1.0" }
  ];

  assert.deepEqual(
    managementState.removeKnowledgeItems(items, ["b@1.0"]),
    [{ file: "a@1.0" }, { file: "c@1.0" }]
  );
});

test("模型编辑按配置 ID 更新，名称不作为覆盖依据", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.upsertModel, "function");

  const initial = [{ configId: "config-1", name: "hunyuan-pro", provider: "旧网关", status: "active" }];
  const updated = managementState.upsertModel(initial, {
    name: "hunyuan-pro",
    configId: "config-1",
    provider: "新网关",
    status: "disabled"
  });

  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], {
    configId: "config-1",
    name: "hunyuan-pro",
    provider: "新网关",
    status: "disabled"
  });
});

test("同名同角色新增模型独立保存，编辑删除不影响其他记录且重启后保留", async () => {
  const { upsertModel, removeModel, findModel, ensureModelIds, buildReviewExecutionConfig } = await managementStatePromise;
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createStorage } = require("../electron/storage.cjs");
  const first = { name: "DeepSeek", modelId: "model-a", role: "analysis", status: "active", testStatus: "passed", credentialRef: "cred://a" };
  const a = upsertModel([], first);
  const b = upsertModel(a, { ...first, modelId: "model-b", credentialRef: "cred://b" });
  assert.equal(b.length, 2);
  assert.ok(b.every((m) => m.configId));
  assert.notEqual(b[0].configId, b[1].configId);
  assert.equal(findModel(b, "DeepSeek"), null, "同名旧引用不得任意选择");
  const edited = upsertModel(b, { ...b[1], name: "重命名", modelId: "model-c" });
  assert.equal(edited[0].modelId, "model-b");
  assert.equal(edited[1].modelId, "model-c");
  assert.equal(removeModel(edited, b[1].configId).length, 1);
  assert.throws(() => upsertModel(b, { ...first, configId: "missing" }));
  const snapshot = buildReviewExecutionConfig({ models: b }, { models: { analysis: b[1] } });
  assert.equal(snapshot.models.analysis.configId, b[1].configId);
  const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "multi-model-")));
  storage.saveState({ capabilities: { models: b } });
  assert.deepEqual(createStorage(storage.rootDir).loadState().capabilities.models, b);
  const migrated = ensureModelIds([{ ...first }, { ...first }]);
  assert.equal(new Set(migrated.map((m) => m.configId)).size, 2);
  assert.deepEqual(ensureModelIds(migrated), migrated);
});

test("模型配置不使用历史演示数据，但保留用户手工配置", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.removeDemoModels, "function");

  const models = managementState.removeDemoModels([
    { name: "hunyuan-pro", modelId: "hunyuan-pro", endpoint: "http://model-gateway.local/v1" },
    { name: "my-deepseek", modelId: "deepseek-chat", endpoint: "https://api.deepseek.com/v1", source: "manual" }
  ]);

  assert.deepEqual(models.map((model) => model.name), ["my-deepseek"]);
});

test("设置合并只修改传入项并保留其他设置", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.mergeSettings, "function");

  const current = {
    autoSave: true,
    autoSaveInterval: 5,
    forceValidator: true
  };

  assert.deepEqual(
    managementState.mergeSettings(current, { autoSaveInterval: 10 }),
    {
      autoSave: true,
      autoSaveInterval: 10,
      forceValidator: true
    }
  );
});

test("编辑法律快照保留快照 ID并更新治理字段", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.updateLegalSnapshot, "function");

  const initial = [{
    id: "CN-2026-09",
    name: "旧快照",
    status: "draft",
    sources: 128,
    coverage: "采购",
    hash: "sha256:demo"
  }];
  const updated = managementState.updateLegalSnapshot(initial, "CN-2026-09", {
    id: "should-not-replace-id",
    name: "法律快照 CN-2026-09",
    status: "published",
    sources: 132,
    coverage: "采购、服务",
    publishedAt: "2026-09-11 10:00"
  });

  assert.equal(updated[0].id, "CN-2026-09");
  assert.equal(updated[0].name, "法律快照 CN-2026-09");
  assert.equal(updated[0].status, "published");
  assert.equal(updated[0].sources, 132);
  assert.equal(updated[0].hash, "sha256:demo");
  assert.equal(initial[0].name, "旧快照");
});

test("编辑企业记忆允许修改内容并保留未传入字段", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.updateEnterpriseMemory, "function");

  const initial = [{
    content: "原记忆内容",
    scope: "组织级",
    type: "企业偏好",
    status: "正式",
    confidence: "0.95"
  }];
  const updated = managementState.updateEnterpriseMemory(initial, "原记忆内容", {
    content: "更新后的记忆内容",
    status: "候选",
    confidence: "0.80"
  });

  assert.equal(updated[0].content, "更新后的记忆内容");
  assert.equal(updated[0].scope, "组织级");
  assert.equal(updated[0].type, "企业偏好");
  assert.equal(updated[0].status, "候选");
  assert.equal(updated[0].confidence, "0.80");
  assert.equal(initial[0].content, "原记忆内容");
});

test("审查执行配置只使用已启用 Skill 和运行中的模型角色", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.buildReviewExecutionConfig, "function");

  const execution = managementState.buildReviewExecutionConfig({
    skills: [
      { name: "common-review", version: "1.0.0", scope: "全部合同", status: "enabled" },
      { name: "isolated-skill", version: "0.1.0", scope: "隔离区", status: "isolated" }
    ],
    models: [
      { name: "analysis-local", modelId: "analysis-local", provider: "本地", role: "analysis", version: "cfg-v2", policy: "local_only", status: "active" },
      { name: "analysis-disabled", modelId: "analysis-disabled", provider: "本地", role: "analysis", version: "cfg-v1", policy: "local_only", status: "disabled" },
      { name: "extract-local", modelId: "extract-local", provider: "本地", role: "extraction", version: "cfg-v1", policy: "local_only", status: "active" }
    ]
  }, {}, "2026-09-11T00:00:00.000Z");

  assert.deepEqual(execution.skills, [
    { name: "common-review", version: "1.0.0", scope: "全部合同" }
  ]);
  assert.deepEqual(execution.models.analysis, {
    name: "analysis-local",
    modelId: "analysis-local",
    provider: "本地",
    version: "cfg-v2",
    policy: "local_only"
  });
  assert.deepEqual(execution.models.extraction, {
    name: "extract-local",
    modelId: "extract-local",
    provider: "本地",
    version: "cfg-v1",
    policy: "local_only"
  });
  assert.equal(execution.models.embedding, null);
  assert.equal(execution.updatedAt, "2026-09-11T00:00:00.000Z");
});

test("未完成配置校验的模型不能进入审查执行快照", async () => {
  const managementState = await managementStatePromise;
  const execution = managementState.buildReviewExecutionConfig({
    skills: [],
    models: [{
      name: "unverified-analysis",
      modelId: "deepseek-chat",
      role: "analysis",
      status: "active",
      testStatus: "untested"
    }]
  });

  assert.equal(execution.models.analysis, null);
});

test("选区标记保存文本快照、文件版本、页码、范围和文本哈希", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.createSelectionAnnotation, "function");

  const annotation = managementState.createSelectionAnnotation({
    text: "客户可随时单方解除且无需承担任何责任",
    fileVersionId: "contract_v1",
    page: 6,
    clauseNo: "8.2",
    charRange: [120, 138]
  });

  assert.equal(annotation.source_type, "manual_selection");
  assert.equal(annotation.text_snapshot, "客户可随时单方解除且无需承担任何责任");
  assert.equal(annotation.file_version_id, "contract_v1");
  assert.equal(annotation.page, 6);
  assert.deepEqual(annotation.char_range, [120, 138]);
  assert.match(annotation.text_hash, /^fnv1a-/);
});

test("局部审查候选绑定选区锚点并默认进入待核验状态", async () => {
  const managementState = await managementStatePromise;
  assert.equal(typeof managementState.createManualReviewRisk, "function");

  const risk = managementState.createManualReviewRisk({
    selection: {
      text_snapshot: "客户可随时单方解除且无需承担任何责任",
      file_version_id: "contract_v1",
      page: 6,
      clause_no: "8.2",
      char_range: [120, 138],
      text_hash: "fnv1a-demo"
    },
    reviewType: "legal_risk",
    topic: "termination"
  });

  assert.equal(risk.source_type, "manual_selection_review");
  assert.equal(risk.conclusion_status, "needs_verification");
  assert.equal(risk.evidence_status, "unverified");
  assert.equal(risk.human_status, "pending_review");
  assert.equal(risk.contract_location.file_version_id, "contract_v1");
  assert.equal(risk.contract_location.page, 6);
  assert.deepEqual(risk.contract_location.char_range, [120, 138]);
  assert.equal(risk.contract_location.text_hash, "fnv1a-demo");
});
