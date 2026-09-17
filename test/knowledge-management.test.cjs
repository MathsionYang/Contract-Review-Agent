const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { knowledgeItemKey, knowledgeItems, deleteKnowledgeEntries } = require("../src/services/knowledgeManagement.mjs");
const { createStorage } = require("../electron/storage.cjs");
const { parseLegalSnapshotFile } = require("../electron/knowledge.cjs");

function fixture() {
  return {
    knowledge: {
      legalSnapshots: [{ id: "snapshot-1", name: "法律", status: "published", clauses: [{ text: "原法律依据" }] }],
      rules: [{ file: "rule.txt", entry_id: "rule-1" }, { file: "rule.txt", entry_id: "rule-2" }],
      policies: [{ file: "policy.md" }], memory: [{ memory_id: "memory-1", content: "example" }]
    },
    projects: [{ project_id: "p" }], activeProjectId: "p",
    reviews: { p: { config: { snapshot: { id: "snapshot-1", status: "published" }, rules: ["rule.txt"], policies: ["policy.md"] }, risks: [{ title: "历史风险", legal_basis: [{ excerpt: "原法律依据" }] }] } },
    auditRecords: [{ audit_id: "audit-1", action: "导入" }]
  };
}

test("五类知识记录均可删除，保留历史证据且旧保存不会复活记录", () => {
  for (const kind of ["legalSnapshots", "rules", "policies", "memory", "audit"]) {
    const initial = fixture();
    const serialized = JSON.stringify(initial);
    const items = knowledgeItems(initial, kind);
    const next = deleteKnowledgeEntries(initial, kind, [knowledgeItemKey(kind, items[0])]);
    assert.equal(JSON.stringify(initial), serialized);
    assert.equal(knowledgeItems(next, kind).some((item) => knowledgeItemKey(kind, item) === knowledgeItemKey(kind, items[0])), false);
    assert.deepEqual(next.reviews.p.risks, initial.reviews.p.risks);
    assert.equal(next.auditRecords[0].event_type, "knowledge_deleted");
    const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-delete-")));
    storage.saveState(next);
    const stale = storage.saveState(initial);
    assert.equal(knowledgeItems(stale, kind).some((item) => knowledgeItemKey(kind, item) === knowledgeItemKey(kind, items[0])), false);
    assert.equal(stale.deletedKnowledge.length, 1);
    assert.ok(stale.auditRecords.some((item) => item.event_type === "knowledge_deleted"));
    if (kind === "audit") assert.equal(stale.deletedKnowledge[0].archived_item, undefined);
    else assert.deepEqual(stale.deletedKnowledge[0].archived_item, items[0]);
  }
});

test("同名文件按稳定键删除，最后一个版本删除后清理配置，重新导入允许共存", () => {
  const initial = fixture();
  const next = deleteKnowledgeEntries(initial, "rules", [knowledgeItemKey("rules", initial.knowledge.rules[0])]);
  assert.equal(next.knowledge.rules.length, 1);
  assert.deepEqual(next.reviews.p.config.rules, ["rule.txt"]);
  const last = deleteKnowledgeEntries(next, "rules", [knowledgeItemKey("rules", next.knowledge.rules[0])]);
  assert.deepEqual(last.reviews.p.config.rules, []);
  const storage = createStorage(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-reimport-")));
  storage.saveState(last);
  last.knowledge.rules.push({ file: "rule.txt", entry_id: "new-entry" });
  assert.equal(storage.saveState(last).knowledge.rules.length, 1);
  const deletedSnapshot = deleteKnowledgeEntries(initial, "legalSnapshots", [knowledgeItemKey("legalSnapshots", initial.knowledge.legalSnapshots[0])]);
  assert.deepEqual(deletedSnapshot.reviews.p.config.snapshot, { id: "", status: "draft" });
});

test("删除请求校验类型、目标和空选择", () => {
  for (const [kind, keys] of [["__proto__", ["x"]], ["policies", []], ["policies", ["missing"]]]) assert.throws(() => deleteKnowledgeEntries(fixture(), kind, keys));
});

test("Markdown 和 TXT 快照自动生成稳定 ID，保留中文法条编号并默认为草稿", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-text-"));
  for (const extension of ["md", "txt"]) {
    const file = path.join(directory, `本地法规.${extension}`);
    fs.writeFileSync(file, "第十条\n条款甲。\n第十一条\n条款乙。", "utf8");
    const result = await parseLegalSnapshotFile(file);
    const again = await parseLegalSnapshotFile(file);
    assert.match(result.id, /^LOCAL-[0-9a-f]{16}$/);
    assert.equal(result.id, again.id);
    assert.equal(result.name, "本地法规");
    assert.equal(result.status, "draft");
    assert.deepEqual(result.clauses.map((clause) => clause.clause_no), ["第十条", "第十一条"]);
    assert.equal(result.clauses[0].text, "条款甲。");
  }
});

test("JSON 快照支持 UTF-8 BOM，空内容或非法来源数不能伪装成已导入法律", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-validation-"));
  const file = path.join(directory, "snapshot.json");
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ id: "s1", name: "BOM snapshot", content: "第一条 法律正文" }));
  assert.equal((await parseLegalSnapshotFile(file)).id, "s1");
  for (const payload of [{ id: "s1", name: "metadata only" }, { id: "s1", name: "negative sources", sources: -1, text: "正文" }, { id: "s1", name: "empty clause", clauses: [{ title: "empty", text: "" }] }]) {
    fs.writeFileSync(file, JSON.stringify(payload));
    await assert.rejects(parseLegalSnapshotFile(file), (error) => error.code === "LEGAL_SNAPSHOT_INVALID");
  }
  const emptyText = path.join(directory, "empty.txt");
  fs.writeFileSync(emptyText, "  \n\t");
  await assert.rejects(parseLegalSnapshotFile(emptyText), /非空条款正文/);
});
