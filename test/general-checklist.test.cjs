const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runGeneralChecklist, CATALOG } = require("../electron/general-checklist.cjs");

function run(text, contractType = "software", extra = {}) {
  return runGeneralChecklist({ document: { text, fileVersionId: "v1", blocks: [{ block_id: "b1", page: null, text }] }, contractType, ...extra });
}
const byId = (result, id) => result.checkResults.find((item) => item.check_id === id);

test("95 项编号与领域清单一致，每项具有判据、证据要求、适用条件与状态", () => {
  const source = fs.readFileSync(path.join(__dirname, "../docs/合同审查内容体系与通用审查清单.md"), "utf8");
  const ids = [...source.matchAll(/^\| (GC-\d-\d{2}) \|/gm)].map((m) => m[1]);
  assert.equal(CATALOG.length, 95);
  assert.deepEqual(CATALOG.map((c) => c.check_id), ids);
  const result = run("软件采购合同，双方约定软件许可。");
  assert.equal(result.checkResults.length, 95);
  for (const item of result.checkResults) {
    assert.ok(item.criterion && item.evidence_requirement && item.method && item.applicability);
    assert.ok(["pass", "conflict", "missing", "unverifiable", "not_applicable"].includes(item.status));
  }
  assert.equal(byId(result, "GC-1-03").status, "unverifiable");
  assert.equal(byId(result, "GC-6-05").status, "unverifiable");
  assert.equal(byId(result, "GC-4-07").status, "not_applicable");
  assert.equal(byId(result, "GC-5-02").status, "unverifiable");
});

test("争议解决、变更、验收与保密输出原文支持的候选，不升级成确认法律结论", () => {
  const result = run("1.1 合同争议可以向法院起诉，也可以向当地仲裁委员会申请仲裁。\n2.1 甲方有权单方调整需求。\n3.1 验收不合格时另行协商。\n4.1 双方负有保密义务，期限三年。");
  for (const id of ["GC-4-19", "GC-4-20", "GC-3-02"]) assert.equal(byId(result, id).status, "conflict", id);
  for (const id of ["GC-2-20", "GC-4-18", "GC-4-23"]) assert.equal(byId(result, id).status, "missing", id);
  for (const finding of result.findings) {
    assert.equal(finding.conclusion_status, "needs_verification");
    assert.notEqual(finding.evidence_status, "verified");
    assert.ok(finding.checklist_ids.length);
    for (const ref of finding.contract_location.source_refs) assert.ok(result.documentText.includes(ref.quote));
  }
});

test("完整保护性约定和司法保全例外不触发关键词误报", () => {
  const result = run("争议提交武汉仲裁委员会仲裁，仲裁前可向法院申请财产保全。\n变更需求须经双方书面确认，并约定费用计价、范围和工期。\n验收不合格由乙方免费修理，连续两次不合格甲方有权解除。\n合同解除后返还已付款项、结算已完成部分并移交资料。\n送达地址为双方注册地址，收件人李某，电话12345，邮箱a@example.com。地址变更须书面通知。\n乙方提供不侵权保证，收到第三方侵权主张时负责抗辩并承担费用与赔偿。");
  assert.equal(byId(result, "GC-4-19").status, "pass");
  assert.equal(byId(result, "GC-4-20").status, "unverifiable");
  for (const id of ["GC-3-02", "GC-2-20", "GC-4-18", "GC-4-23", "GC-3-07"]) assert.notEqual(byId(result, id).status, "missing", id);
});

test("引用条款须为真实定义，不能把引用自身或版本号当作定义", () => {
  const result = run("1.1 使用软件V3.0。按第9.9条承担责任。\n2.1 按第1.1条交付。\n2.1 双方另有约定。");
  assert.equal(byId(result, "GC-2-25").status, "conflict");
  assert.match(byId(result, "GC-2-25").message, /9\.9/);
  assert.equal(byId(result, "GC-6-08").status, "conflict");
});

test("保证与独家检查按适用性触发，已明确一般保证仍仅提示业务选择", () => {
  const result = run("保证人为丙公司，为债务人提供一般保证。保证期间为主债务到期后六个月。独家合作期限三年，地域为湖南，品类为软件，最低采购量100套，违约承担赔偿责任。");
  assert.equal(byId(result, "GC-4-07").status, "unverifiable");
  assert.doesNotMatch(byId(result, "GC-4-07").message, /无效|必须连带/);
  assert.notEqual(byId(result, "GC-3-04").status, "missing");
});

test("付款主观条件、交付要素和数据处理缺项均进入通用清单", () => {
  const result = run("2.1 甲方满意后支付尾款。\n3.1 乙方交付软件。\n4.1 乙方处理甲方客户个人信息。");
  assert.equal(byId(result, "GC-2-11").status, "conflict");
  assert.ok(byId(result, "GC-2-11").source_refs[0].quote.includes("满意"));
  for (const id of ["GC-2-09", "GC-2-10", "GC-2-14", "GC-3-10"]) {
    assert.equal(byId(result, id).status, "missing", id);
  }
  assert.ok(byId(result, "GC-3-10").gaps.includes("处理目的"));
});

test("关键词筛查不能用其他条款的要素掩盖当前条款缺失", () => {
  const result = run("独家合作期限三年。\n交付地域为湖南，软件品类明确。最低采购量100套，逾期交货承担违约责任。");
  assert.equal(byId(result, "GC-3-04").status, "missing");
  assert.ok(byId(result, "GC-3-04").gaps.includes("地域"));
});

test("清单通过必须覆盖完整判据，未解析引用不算通过，保留具体材料要求", () => {
  const result = run("1.1 依第1.1条及第十条处理争议。申请仲裁或法院诉讼。甲方已取得全部审批，印章真实。");
  assert.notEqual(byId(result, "GC-2-25").status, "pass");
  assert.notEqual(byId(result, "GC-4-19").status, "pass");
  assert.equal(byId(result, "GC-1-05").status, "unverifiable");
  assert.ok(byId(result, "GC-1-05").required_materials.some((m) => m.includes("授权")));
});
