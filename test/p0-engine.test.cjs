const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let knowledge;
let reviewEngine;
let storageModule;
let modelGateway;
let legalSource;
let reviewRunner;
try {
  knowledge = require("../electron/knowledge.cjs");
} catch (_error) {
  knowledge = {};
}
try {
  reviewEngine = require("../electron/review-engine.cjs");
} catch (_error) {
  reviewEngine = {};
}
try {
  storageModule = require("../electron/storage.cjs");
} catch (_error) {
  storageModule = {};
}
try {
  modelGateway = require("../electron/model-gateway.cjs");
} catch (_error) {
  modelGateway = {};
}
try {
  legalSource = require("../electron/legal-source.cjs");
} catch (_error) {
  legalSource = {};
}
try {
  reviewRunner = require("../electron/review-runner.cjs");
} catch (_error) {
  reviewRunner = {};
}

test("知识文件条款抽取保留编号、标题和原文", () => {
  assert.equal(typeof knowledge.extractKnowledgeClauses, "function");

  const clauses = knowledge.extractKnowledgeClauses(
    "第 4.2 节 预付款\n预付款比例不得超过 30%，超过时需要专项审批。\n第 4.3 节 验收\n验收完成后方可申请付款。",
    "policies"
  );

  assert.deepEqual(clauses, [
    {
      clause_no: "4.2",
      title: "预付款",
      text: "预付款比例不得超过 30%，超过时需要专项审批。",
      keywords: ["预付款", "比例", "不得超过", "30%", "超过时", "需要专项审批"]
    },
    {
      clause_no: "4.3",
      title: "验收",
      text: "验收完成后方可申请付款。",
      keywords: ["验收", "完成后方可申请付款"]
    }
  ]);
});

test("知识检索只返回已选来源并携带具体依据条款", () => {
  assert.equal(typeof knowledge.buildKnowledgeItem, "function");
  assert.equal(typeof knowledge.searchKnowledgeSources, "function");

  const selected = knowledge.buildKnowledgeItem({
    kind: "policies",
    fileName: "采购制度.docx",
    summary: "采购付款规则",
    version: "v1",
    sha256: "sha256:policy-1",
    selected: true,
    clauses: [{ clause_no: "4.2", title: "预付款", text: "预付款比例不得超过 30%" }]
  });
  const ignored = knowledge.buildKnowledgeItem({
    kind: "policies",
    fileName: "未选制度.docx",
    version: "v1",
    sha256: "sha256:policy-2",
    selected: false,
    clauses: [{ clause_no: "4.2", title: "预付款", text: "预付款比例不得超过 10%" }]
  });

  const hits = knowledge.searchKnowledgeSources([selected, ignored], "预付款比例");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file_name, "采购制度.docx");
  assert.equal(hits[0].clause_no, "4.2");
  assert.equal(hits[0].clause_title, "预付款");
  assert.match(hits[0].excerpt, /30%/);
  assert.equal(hits[0].source_type, "enterprise_policy");
});

test("确定性规则分别输出命中、未命中和无法判断", () => {
  assert.equal(typeof reviewEngine.evaluateDeterministicRules, "function");

  const rules = [
    { id: "R-PREPAY-30", version: "1.0", type: "amount_ratio", threshold: 0.3, label: "预付款不得超过 30%", clause_no: "R-001" },
    { id: "R-SIGNATURE", version: "1.0", type: "required_clause", keyword: "授权代表签字", label: "必须包含授权代表签字条款", clause_no: "R-002" },
    { id: "R-DATE-ORDER", version: "1.0", type: "date_order", from: "交付日期", to: "签署日期", label: "交付日期顺序检查", clause_no: "R-003" }
  ];

  const findings = reviewEngine.evaluateDeterministicRules({
    text: "合同总价 100 元，预付款 40%。双方授权代表签字后生效。",
    pages: [{ page: 1, text: "合同总价 100 元，预付款 40%。双方授权代表签字后生效。" }],
    sha256: "contract-hash",
    fileVersionId: "contract_v1"
  }, rules, { contractType: "procurement" });

  assert.equal(findings.length, 3);
  assert.equal(findings.find((item) => item.rule_id === "R-PREPAY-30").conclusion_status, "candidate");
  assert.equal(findings.find((item) => item.rule_id === "R-PREPAY-30").evidence_status, "verified");
  assert.equal(findings.find((item) => item.rule_id === "R-SIGNATURE").conclusion_status, "rejected");
  assert.equal(findings.find((item) => item.rule_id === "R-DATE-ORDER").conclusion_status, "needs_verification");
});

test("模型输出必须归一化为允许的风险结构，非法 JSON 不得形成确认风险", () => {
  assert.equal(typeof reviewEngine.normalizeModelRisks, "function");

  const result = reviewEngine.normalizeModelRisks(
    { content: "not-json" },
    {
      fileVersionId: "contract_v1",
      document: { pageCount: 1, pages: [{ page: 1, text: "合同条款" }] }
    }
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].conclusion_status, "needs_verification");
  assert.equal(result[0].evidence_status, "unverified");
  assert.equal(result[0].human_status, "pending_review");
  assert.equal(result[0].source_type, "model_analysis");
});

test("模型风险与规则风险合并时保留具体依据并去除重复风险", () => {
  assert.equal(typeof reviewEngine.mergeReviewFindings, "function");

  const merged = reviewEngine.mergeReviewFindings([
    {
      risk_id: "rule-R-PREPAY-30",
      source_type: "deterministic_rule",
      title: "预付款超过制度上限",
      risk_level: "high",
      contract_location: { file_version_id: "contract_v1", page: 1, clause_no: "4.2", quote: "预付款 40%" },
      legal_basis: [],
      company_basis: [{ source_id: "policy-1", file_name: "采购制度.docx", clause_no: "4.2", clause_title: "预付款", excerpt: "预付款比例不得超过 30%" }]
    },
    {
      risk_id: "model-1",
      source_type: "model_analysis",
      title: "预付款超过制度上限",
      risk_level: "high",
      contract_location: { file_version_id: "contract_v1", page: 1, clause_no: "4.2", quote: "预付款 40%" },
      legal_basis: [],
      company_basis: []
    }
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].company_basis[0].clause_no, "4.2");
  assert.match(merged[0].company_basis[0].excerpt, /30%/);
});

test("知识文件上传保存到独立版本目录并返回哈希元数据", () => {
  assert.equal(typeof storageModule.createStorage, "function");
  assert.equal(typeof knowledge.validateKnowledgeFile, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-knowledge-"));
  const sourcePath = path.join(root, "采购制度.txt");
  fs.writeFileSync(sourcePath, "第 4.2 节 预付款\n预付款比例不得超过 30%", "utf8");
  const storage = storageModule.createStorage(path.join(root, "user-data"));
  const metadata = knowledge.validateKnowledgeFile(sourcePath, "policies");
  const saved = storage.saveKnowledgeFile({
    kind: "policies",
    versionId: "knowledge_policies_policy-1",
    sourcePath: metadata.filePath,
    fileName: metadata.fileName
  });

  assert.equal(saved.fileName, "采购制度.txt");
  assert.equal(saved.sizeBytes, metadata.size);
  assert.equal(saved.sha256, metadata.sha256);
  assert.match(saved.storedPath, /knowledge[\\/]policies[\\/]knowledge_policies_policy-1/);
  assert.equal(fs.readFileSync(saved.storedPath, "utf8"), "第 4.2 节 预付款\n预付款比例不得超过 30%");
});

test("知识文件上传拒绝不支持的扩展名", () => {
  assert.equal(typeof knowledge.validateKnowledgeFile, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-invalid-"));
  const sourcePath = path.join(root, "malware.exe");
  fs.writeFileSync(sourcePath, "not a knowledge file", "utf8");

  assert.throws(
    () => knowledge.validateKnowledgeFile(sourcePath, "rules"),
    (error) => error.code === "KNOWLEDGE_FILE_INVALID"
  );
});

test("知识文件内容解析为可检索条款", async () => {
  assert.equal(typeof knowledge.parseKnowledgeFile, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-parse-"));
  const sourcePath = path.join(root, "规则.md");
  fs.writeFileSync(sourcePath, "## R-001 付款比例\n预付款比例不得超过 30%。", "utf8");
  const parsed = await knowledge.parseKnowledgeFile(sourcePath, "rules");

  assert.equal(parsed.parseStatus, "parsed");
  assert.equal(parsed.clauses[0].clause_no, "R-001");
  assert.equal(parsed.clauses[0].title, "付款比例");
  assert.match(parsed.clauses[0].text, /30%/);
});

test("模型网关调用 OpenAI 兼容接口并返回脱敏的结构化数据", async () => {
  assert.equal(typeof modelGateway.invokeModel, "function");
  let request;
  const result = await modelGateway.invokeModel({
    model: {
      endpoint: "https://model.example/v1",
      modelId: "analysis-model",
      credentialRef: "cred://legal"
    },
    messages: [{ role: "user", content: "审查付款条款" }],
    responseSchema: { type: "object", properties: { risks: { type: "array" } } },
    credentialResolver: (reference) => {
      assert.equal(reference, "cred://legal");
      return "top-secret-token";
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"risks":[{"title":"付款条款需核验"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { risks: [{ title: "付款条款需核验" }] });
  assert.equal(result.usage.total_tokens, 18);
  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(JSON.stringify(result).includes("top-secret-token"), false);
  assert.match(request.options.headers.Authorization, /^Bearer /);
});

test("模型网关保留脱敏后的服务商错误，并拦截错误的 DeepSeek 模型标识", async () => {
  const failed = await modelGateway.invokeModel({
    model: { endpoint: "https://api.deepseek.com", modelId: "deepseek-chat", credentialRef: "cred://deepseek/analysis" },
    credentialResolver: () => "secret-key",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "The model does not exist", code: "invalid_request_error" } })
    })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "MODEL_REQUEST_FAILED");
  assert.match(failed.message, /HTTP 400/);
  assert.match(failed.message, /The model does not exist/);
  assert.doesNotMatch(failed.message, /secret-key/);

  const invalidModel = await modelGateway.invokeModel({
    model: { endpoint: "https://api.deepseek.com", modelId: "DeepSeek", credentialRef: "none" },
    fetchImpl: async () => { throw new Error("不应发起请求"); }
  });
  assert.equal(invalidModel.errorCode, "MODEL_CONFIG_INVALID");
  assert.match(invalidModel.message, /deepseek-chat/);
});

test("法律实时核验拒绝白名单之外的地址并保留机器错误码", async () => {
  assert.equal(typeof legalSource.verifyLegalSource, "function");
  const denied = await legalSource.verifyLegalSource({
    url: "https://not-allowed.example/search",
    query: "民法典",
    allowlist: ["https://legal.example"],
    fetchImpl: async () => { throw new Error("不应发起请求"); }
  });

  assert.equal(denied.status, "unauthorized");
  assert.equal(denied.errorCode, "SOURCE_UNAVAILABLE");
  assert.deepEqual(denied.sources, []);
});

test("法律快照 JSON 导入保留快照身份和具体条款", async () => {
  assert.equal(typeof knowledge.parseLegalSnapshotFile, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-snapshot-"));
  const sourcePath = path.join(root, "法律快照.json");
  fs.writeFileSync(sourcePath, JSON.stringify({
    id: "CN-LOCAL-01",
    name: "本地法律快照",
    status: "published",
    coverage: "采购合同",
    publishedAt: "2026-09-11",
    clauses: [{ clause_no: "第五百零九条", title: "全面履行义务", text: "当事人应当按照约定全面履行自己的义务。" }]
  }), "utf8");

  const parsed = await knowledge.parseLegalSnapshotFile(sourcePath);
  assert.equal(parsed.id, "CN-LOCAL-01");
  assert.equal(parsed.status, "published");
  assert.match(parsed.hash, /^sha256:/);
  assert.equal(parsed.clauses[0].clause_no, "第五百零九条");
  assert.match(parsed.clauses[0].text, /全面履行/);
});

test("法律快照导入拒绝无法解析的 JSON", async () => {
  assert.equal(typeof knowledge.parseLegalSnapshotFile, "function");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-review-bad-snapshot-"));
  const sourcePath = path.join(root, "bad.json");
  fs.writeFileSync(sourcePath, "{broken", "utf8");

  await assert.rejects(
    () => knowledge.parseLegalSnapshotFile(sourcePath),
    (error) => error.code === "LEGAL_SNAPSHOT_INVALID"
  );
});

test("真实审查编排使用规则和知识检索生成带具体条款的风险", async () => {
  assert.equal(typeof reviewRunner.runReview, "function");

  const result = await reviewRunner.runReview({
    review: {
      review_version_id: "RV-LOCAL-01",
      project: { project_id: "project-local", file_version_id: "contract_v1", contract_type: "procurement", review_mode: "standard" },
      document: {
        fileVersionId: "contract_v1",
        pageCount: 1,
        text: "第四条 付款\n预付款 40%。",
        pages: [{ page: 1, text: "第四条 付款\n预付款 40%。" }]
      },
      config: { snapshot: { id: "CN-LOCAL-01", status: "published" }, rules: ["payment-rules"], policies: ["采购制度.docx"] },
      task: { task_id: "task-local", status: "queued", progress: 0 }
    },
    state: {
      knowledge: {
        legalSnapshots: [{ id: "CN-LOCAL-01", name: "本地法律快照", status: "published", clauses: [] }],
        rules: [{ file: "payment-rules", selected: true, type: "金额计算", clauses: [{ clause_no: "R-001", title: "预付款比例", text: "预付款比例不得超过 30%" }] }],
        policies: [{ file: "采购制度.docx", selected: true, version: "v1", clauses: [{ clause_no: "4.2", title: "预付款", text: "预付款比例不得超过 30%，超过时需要专项审批。" }] }]
      },
      capabilities: { models: [], skills: [] },
      settings: {}
    },
    services: {
      invokeModel: async () => ({ ok: false, errorCode: "MODEL_CONFIG_INVALID", message: "测试未配置模型" })
    }
  });

  assert.equal(result.review.task.status, "completed");
  assert.ok(result.review.risks.length > 0);
  const risk = result.review.risks[0];
  assert.equal(risk.source_type, "deterministic_rule");
  assert.equal(risk.company_basis[0].file_name, "采购制度.docx");
  assert.equal(risk.company_basis[0].clause_no, "4.2");
  assert.match(risk.company_basis[0].excerpt, /30%/);
  assert.equal(result.review.risks.some((item) => item.source_type === "sample_data"), false);
});
