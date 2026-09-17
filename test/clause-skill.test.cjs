const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  discoverSkills, loadSkillDescriptor, validateBlocksOutput, analyzeBlocks, BLOCK_OUTPUT_CONTRACT
} = require("../electron/clause-skill.cjs");

// 用一个临时 Skill 目录验证"不写死"：名称、脚本名、契约都由目录自己声明。
function withSkillDir(setup, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clause-skill-"));
  const previous = process.env.DSH_CONTRACT_SKILL_DIR;
  const previousBuiltin = process.env.DSH_CONTRACT_SKILL_BUILTIN_DIR;
  process.env.DSH_CONTRACT_SKILL_DIR = root;
  // 隔离内置目录，避免仓库自带的 Skill 让用例结果依赖本机环境。
  process.env.DSH_CONTRACT_SKILL_BUILTIN_DIR = path.join(root, '__no_builtin__');
  try {
    setup(root);
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.DSH_CONTRACT_SKILL_DIR;
    else process.env.DSH_CONTRACT_SKILL_DIR = previous;
    if (previousBuiltin === undefined) delete process.env.DSH_CONTRACT_SKILL_BUILTIN_DIR;
    else process.env.DSH_CONTRACT_SKILL_BUILTIN_DIR = previousBuiltin;
  }
}

function writeSkill(root, { name, script = "scripts/extract_blocks.py", contract = {}, frontMatter = true }) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const fm = frontMatter ? `---\nname: ${name}\ndescription: 测试用条款抽取 Skill\n---\n\n# ${name}\n` : `# ${name}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), fm);
  fs.writeFileSync(path.join(dir, script), "#!/usr/bin/env python3\n");
  if (Object.keys(contract).length) fs.writeFileSync(path.join(dir, "skill.pipeline.json"), JSON.stringify(contract, null, 2));
  return dir;
}

test("Skill 由目录发现，名称与脚本名不写死", () => {
  withSkillDir((root) => {
    writeSkill(root, { name: "another-extractor", script: "scripts/custom_runner.py",
      contract: { script: "scripts/custom_runner.py", outputs: ["blocks"] } });
  }, () => {
    const skills = discoverSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "another-extractor");
    assert.ok(skills[0].script.endsWith("custom_runner.py"), "脚本名必须来自声明而不是约定值");
    assert.equal(skills[0].contractSource, "skill.pipeline.json");
  });
});

test("没有声明文件时回退到约定脚本名，旧目录仍可接入", () => {
  withSkillDir((root) => { writeSkill(root, { name: "legacy-extractor", contract: {} }); }, () => {
    const skills = discoverSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].contractSource, "convention");
    assert.ok(skills[0].script.endsWith(path.join("scripts", "extract_blocks.py")));
  });
});

test("未声明 blocks 能力的 Skill 不会被当作抽取 Skill", () => {
  withSkillDir((root) => {
    writeSkill(root, { name: "unrelated-skill", contract: { script: "scripts/extract_blocks.py", outputs: ["clauses"] } });
  }, () => {
    const descriptor = loadSkillDescriptor({ refresh: true });
    assert.equal(descriptor.ok, false);
    assert.equal(descriptor.reason, "skill_not_found");
    // 仍然被发现，只是不被选作抽取 Skill——便于界面提示而不是静默忽略。
    assert.equal(descriptor.skills.length, 1);
  });
});

test("缺少 SKILL.md 或脚本的目录不会被收编", () => {
  withSkillDir((root) => {
    fs.mkdirSync(path.join(root, "no-skill-md"), { recursive: true });
    writeSkill(root, { name: "missing-script" });
    fs.rmSync(path.join(root, "missing-script", "scripts", "extract_blocks.py"));
  }, () => {
    assert.deepEqual(discoverSkills(), []);
  });
});

test("输出契约校验能识别 Skill 升级带来的字段变化", () => {
  assert.equal(validateBlocksOutput({ blocks: [] }).ok, true);
  assert.equal(validateBlocksOutput({}).ok, false);
  assert.match(validateBlocksOutput({}).message, /缺少字段 blocks/);
  assert.equal(validateBlocksOutput({ blocks: "not-an-array" }).ok, false);
  assert.equal(validateBlocksOutput({ blocks: [{ text: "只有文本" }] }).ok, false);
  assert.match(validateBlocksOutput({ blocks: [{ text: "只有文本" }] }).message, /缺少字段 kind/);
  assert.equal(validateBlocksOutput({ blocks: [{ kind: "paragraph" }] }).ok, false);
  assert.match(validateBlocksOutput({ blocks: [{ kind: "paragraph" }] }).message, /缺少 text/);
  assert.equal(validateBlocksOutput({ blocks: [{ kind: "table" }] }).ok, false);
  assert.match(validateBlocksOutput({ blocks: [{ kind: "table" }] }).message, /缺少 markdown/);
  // 未知 kind 必须拦住：否则新版本引入的类型会被当成段落静默处理。
  assert.equal(validateBlocksOutput({ blocks: [{ kind: "image" }] }).ok, false);
  assert.match(validateBlocksOutput({ blocks: [{ kind: "image" }] }).message, /kind=image 不在支持范围/);
  // 新增字段不能破坏集成
  assert.equal(validateBlocksOutput({ blocks: [{ kind: "paragraph", text: "x", future_field: 1 }], extra: true }).ok, true);
  assert.deepEqual(BLOCK_OUTPUT_CONTRACT.kinds, ["paragraph", "table"]);
});

test("条边界对齐：目录与正文同名标题只取正文那一次", () => {
  // 目录条目（偏移靠前）与正文条标题（偏移靠后）文本相同；
  // 正文各自用唯一文本区分，避免把"对齐是否正确"与"重复块去重"混在一起。
  const text = "第一条 定义\n第二条 价款\n\n第一条 定义\n正文甲\n第二条 价款\n正文乙";
  const document = { text, blocks: [
    { block_id: "toc_1", text: "第一条 定义" },
    { block_id: "toc_2", text: "第二条 价款" },
    { block_id: "body_1", text: "第一条 定义" },
    { block_id: "body_2", text: "第二条 价款" }
  ] };
  const blocks = [
    { kind: "paragraph", text: "第一条 定义", heading_level: 1 },
    { kind: "paragraph", text: "第二条 价款", heading_level: 1 }
  ];
  const result = analyzeBlocks(blocks, document);
  assert.equal(result.articles.length, 2, "同名标题必须去重为两条");
  assert.deepEqual(result.articles.map((item) => item.clause_no), ["第一条", "第二条"]);
  // 必须锚定到正文块，而不是目录条目
  assert.deepEqual(result.articles.map((item) => item.block_id), ["body_1", "body_2"]);
  // 偏移必须指向正文条标题的位置（目录副本在前，正文副本在后）
  assert.equal(result.articles[0].char_start, text.indexOf("第一条 定义", text.indexOf("正文甲") - 12));
  assert.ok(result.articles[0].char_start > text.indexOf("第二条 价款"), "必须取正文中的那一次出现而不是目录副本");
  assert.equal(result.articles.every((item, index) => index === 0 || item.char_start > result.articles[index - 1].char_start), true);
});

test("非条标题的段落不产生条边界，附件标题也不误判", () => {
  const document = { text: "第一条 定义\n附件一 技术规格书\n1.1 内容", blocks: [{ block_id: "b1", text: "第一条 定义" }] };
  const blocks = [
    { kind: "paragraph", text: "第一条 定义", heading_level: 1 },
    { kind: "paragraph", text: "附件一 技术规格书", heading_level: 2 },
    { kind: "paragraph", text: "1.1 内容", heading_level: 0 },
    { kind: "table", markdown: "| a | b |" }
  ];
  const result = analyzeBlocks(blocks, document);
  assert.deepEqual(result.articles.map((item) => item.clause_no), ["第一条"]);
  assert.equal(result.heading_count, 1, "只有条级编号才算条标题");
});

