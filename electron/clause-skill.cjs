// 条款抽取 Skill 适配层。
//
// 维护原则：不写死单个 Skill 的名称、路径与输出结构。
// - Skill 由目录扫描发现，可来自仓库内置或用户数据目录，升级时只需替换目录；
// - 脚本文件名、解释器与输出契约由 Skill 自己声明（skill.pipeline.json），缺省则用约定值；
// - 输出结构在适配层做契约校验，Skill 升级导致字段变化时给出明确诊断而不是静默失败；
// - 任何失败都降级为 ok:false，由审查链路回退到内置解析，不阻塞用户。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// 内置 Skill 目录：仓库内置与用户级安装目录都会被扫描，后者优先（便于覆盖与升级）。
// 两个目录都可用环境变量覆盖，便于部署定制与测试隔离。
function builtinSkillDirs() {
  const override = String(process.env.DSH_CONTRACT_SKILL_BUILTIN_DIR || "").trim();
  return override ? [override] : [path.join(__dirname, "..", "skills")];
}
const DEFAULT_SCRIPT = path.join("scripts", "extract_blocks.py");
const CONTRACT_FILE = "skill.pipeline.json";

// 适配层期望的块输出契约。Skill 升级后若改了字段名，校验会明确指出缺什么。
const BLOCK_OUTPUT_CONTRACT = {
  required_root: ["blocks"],
  required_block: ["kind"],
  text_keys: ["text", "markdown"],
  kinds: ["paragraph", "table"]
};

// 条款起始编号：第X条 / 第X章。只认条级形式，数字条款（1.1）不足以判定条边界。
const ARTICLE_PATTERN = /^(第\s*[一二三四五六七八九十百零〇\d]{1,6}\s*条)(?![\d])/;
const CHAPTER_PATTERN = /^(第\s*[一二三四五六七八九十百零〇\d]{1,6}\s*章)/;

function userSkillDirs() {
  const dirs = [];
  const override = String(process.env.DSH_CONTRACT_SKILL_DIR || "").trim();
  if (override) dirs.push(override);
  try {
    const { app } = require("electron");
    const base = app?.getPath?.("userData");
    if (base) dirs.push(path.join(base, "skills"));
  } catch (_error) { /* 测试环境没有 electron */ }
  return dirs;
}

function skillSearchDirs() {
  return [...userSkillDirs(), ...builtinSkillDirs()];
}

// 解析 SKILL.md 的 YAML 前置元数据（只取标量，不引入 YAML 依赖）。
function parseFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(markdown || ""));
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
  }
  return meta;
}

// 读取 Skill 自带的流水线声明；没有声明时回退到约定值，保证旧目录也能接入。
function readPipelineContract(skillDir) {
  const declared = path.join(skillDir, CONTRACT_FILE);
  if (fs.existsSync(declared)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(declared, "utf8"));
      if (parsed && typeof parsed === "object") return { ...parsed, source: CONTRACT_FILE };
    } catch (_error) { /* 声明损坏时退回约定值，并在健康信息里提示 */ }
  }
  return { script: DEFAULT_SCRIPT, source: "convention" };
}

function discoverSkills() {
  const found = [];
  const seen = new Set();
  for (const dir of skillSearchDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const skillDir = path.join(dir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      // 只收编声明了"条款抽取"能力的 Skill，避免误用无关技能。
      const meta = parseFrontMatter(fs.readFileSync(skillFile, "utf8"));
      const contract = readPipelineContract(skillDir);
      const script = path.join(skillDir, contract.script || DEFAULT_SCRIPT);
      if (!fs.existsSync(script)) continue;
      seen.add(entry.name);
      found.push({ name: meta.name || entry.name, version: meta.version || "", description: meta.description || "",
        directory: skillDir, script, contract, contractSource: contract.source,
        declares_blocks: contract.outputs ? contract.outputs.includes("blocks") : true });
    }
  }
  return found;
}

// Skill 目录可能被替换（升级）：按 mtime 失效缓存，无需重启进程。
let cachedDescriptor = null;
function loadSkillDescriptor({ refresh = false } = {}) {
  if (cachedDescriptor && !refresh) {
    const stamp = descriptorStamp(cachedDescriptor);
    if (stamp === cachedDescriptor.stamp) return cachedDescriptor;
  }
  const skills = discoverSkills();
  const blocks = skills.filter((skill) => skill.declares_blocks);
  if (!blocks.length) {
    cachedDescriptor = { ok: false, reason: "skill_not_found", message: "未发现可用的条款抽取 Skill", skills };
    return cachedDescriptor;
  }
  const chosen = blocks[0];
  cachedDescriptor = { ok: true, skill: chosen, skills, stamp: descriptorStamp(chosen) };
  return cachedDescriptor;
}

function descriptorStamp(skill) {
  try { return `${skill.script}:${fs.statSync(skill.script).mtimeMs}:${fs.statSync(path.join(skill.directory, "SKILL.md")).mtimeMs}`; }
  catch (_error) { return `${skill.script}:missing`; }
}

// 解释器候选优先取 Skill 自身声明，其次取环境变量覆盖，最后用平台默认值。
function candidateInterpreters(contract = {}) {
  const configured = String(process.env.DSH_CONTRACT_SKILL_PYTHON || "").trim();
  if (configured) return [configured];
  const declared = contract?.runtime?.interpreter_candidates;
  if (declared) {
    const list = process.platform === "win32" ? declared.win32 : declared.default;
    if (Array.isArray(list) && list.length) return list;
  }
  return process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], ...options });
    } catch (error) {
      resolve({ ok: false, code: null, stderr: error.message });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    child.stderr?.on("data", (chunk) => { if (stderr.length < 4000) stderr += String(chunk); });
    child.on("error", (error) => finish({ ok: false, code: null, stderr: error.message }));
    const timer = setTimeout(() => { try { child.kill(); } catch (_error) { /* 已退出 */ } finish({ ok: false, code: null, stderr: "Skill 执行超时" }); }, options.timeoutMs || 30000);
    child.on("close", (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stderr: stderr.trim() }); });
  });
}

// 解释器探测结果按 Skill 版本缓存；Skill 升级后自动重新探测。
let probeCache = new Map();
async function probeSkill(options = {}) {
  const descriptor = loadSkillDescriptor(options);
  if (!descriptor.ok) return { available: false, reason: descriptor.reason, message: descriptor.message, skills: descriptor.skills };
  const key = descriptor.stamp;
  if (!options.refresh && probeCache.has(key)) return probeCache.get(key);
  const result = await probeDescriptor(descriptor.skill);
  probeCache = new Map([[key, result]]);
  return result;
}

async function probeDescriptor(skill) {
  for (const interpreter of candidateInterpreters(skill.contract)) {
    // 用不存在的文件跑一次：返回码 2 说明解释器与脚本都能启动。
    const result = await run(interpreter, [skill.script, "__probe_missing_file__"], { timeoutMs: 15000 });
    if (result.code === 2) return { available: true, interpreter, reason: "ok", skill: describe(skill) };
    if (/ModuleNotFoundError|ImportError/i.test(result.stderr)) {
      return { available: false, reason: "missing_dependency", interpreter,
        message: result.stderr.split("\n")[0], skill: describe(skill) };
    }
    if (result.code === null && /ENOENT|not found|不是内部或外部命令/i.test(result.stderr)) continue;
    if (result.code !== null) return { available: true, interpreter, reason: "ok", degraded: true, skill: describe(skill) };
  }
  return { available: false, reason: "python_not_found", message: "未检测到可用的 Python 解释器", skill: describe(skill) };
}

function describe(skill) {
  return { name: skill.name, version: skill.version, directory: skill.directory, contract_source: skill.contractSource };
}

// 输出契约校验：Skill 升级改了字段就明确报错，而不是让下游拿到 undefined。
function validateBlocksOutput(data) {
  if (!data || typeof data !== "object") return { ok: false, message: "Skill 输出不是 JSON 对象" };
  for (const key of BLOCK_OUTPUT_CONTRACT.required_root) {
    if (!(key in data)) return { ok: false, message: `Skill 输出缺少字段 ${key}（当前契约：${BLOCK_OUTPUT_CONTRACT.required_root.join("、")}）` };
  }
  if (!Array.isArray(data.blocks)) return { ok: false, message: "Skill 输出的 blocks 不是数组" };
  for (const [index, block] of data.blocks.entries()) {
    if (!block || typeof block !== "object") return { ok: false, message: `第 ${index} 个块不是对象` };
    for (const key of BLOCK_OUTPUT_CONTRACT.required_block) {
      if (!(key in block)) return { ok: false, message: `第 ${index} 个块缺少字段 ${key}` };
    }
    if (!BLOCK_OUTPUT_CONTRACT.kinds.includes(block.kind)) {
      return { ok: false, message: `第 ${index} 个块的 kind=${block.kind} 不在支持范围（${BLOCK_OUTPUT_CONTRACT.kinds.join("、")}）` };
    }
    if (block.kind === "paragraph" && typeof block.text !== "string") return { ok: false, message: `第 ${index} 个段落块缺少 text` };
    if (block.kind === "table" && typeof block.markdown !== "string") return { ok: false, message: `第 ${index} 个表格块缺少 markdown` };
  }
  return { ok: true };
}

async function readBlocks(filePath, options = {}) {
  const descriptor = loadSkillDescriptor(options);
  if (!descriptor.ok) return { ok: false, source: "unavailable", message: descriptor.message, reason: descriptor.reason };
  const probe = await probeSkill(options);
  if (!probe.available) return { ok: false, source: "unavailable", probe, message: probe.message || "Skill 不可用" };
  const outPath = path.join(options.tempDir || os.tmpdir(), `clause-blocks-${process.pid}-${Date.now()}.json`);
  try {
    const result = await run(probe.interpreter, [descriptor.skill.script, filePath, "--out", outPath],
      { timeoutMs: options.timeoutMs || 60000 });
    if (!result.ok) return { ok: false, source: "failed", probe, message: result.stderr || `退出码 ${result.code}` };
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const validated = validateBlocksOutput(parsed);
    if (!validated.ok) return { ok: false, source: "contract_mismatch", probe, message: validated.message };
    return { ok: true, source: "skill", probe, skill: describe(descriptor.skill), data: parsed };
  } catch (error) {
    return { ok: false, source: "failed", probe, message: error.message };
  } finally {
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_error) { /* 临时文件清理失败不影响结果 */ }
  }
}

function compactIndex(text) {
  const map = [];
  let compact = "";
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    compact += text[index];
    map.push(index);
  }
  return { compact, map };
}

function isArticleHeading(block) {
  if (!block || block.kind !== "paragraph") return false;
  const text = String(block.text || "");
  return ARTICLE_PATTERN.test(text) || CHAPTER_PATTERN.test(text);
}

function analyzeBlocks(blocks, document) {
  const text = String(document?.text || "");
  const { compact, map } = compactIndex(text);
  const blockSpans = [];
  for (const block of document?.blocks || []) {
    const blockCompact = String(block.text || "").replace(/\s+/g, "");
    if (!blockCompact) continue;
    let cursor = 0;
    while (cursor <= compact.length) {
      const at = compact.indexOf(blockCompact, cursor);
      if (at < 0) break;
      blockSpans.push({ block, start: at, end: at + blockCompact.length });
      cursor = at + 1;
    }
  }
  const headings = (blocks || []).filter(isArticleHeading);
  // 目录条目与正文条标题文本相同（docx 的 TOC 也是普通段落），必须消除目录副本。
  //
  // 注意：不能"每个标题块各扫一次"，因为同名标题会出现多个块（目录+正文），
  // 逐块扫描时游标只前进一次，后续同名块匹配不到第二次出现。
  // 正确做法是按"唯一标题文本"枚举全部出现位置，再对每个条号取最后一次出现，
  // 最后保留严格递增序列——正文整段在目录之后，因此目录副本会被自然剔除。
  const headingTexts = new Map();
  const levelByClause = new Map();
  for (const block of headings) {
    const heading = String(block.text || "").replace(/\s+/g, "");
    const match = ARTICLE_PATTERN.exec(String(block.text)) || CHAPTER_PATTERN.exec(String(block.text));
    const clauseNo = match ? match[1].replace(/\s+/g, "") : heading.slice(0, 24);
    if (!headingTexts.has(heading)) headingTexts.set(heading, clauseNo);
    levelByClause.set(clauseNo, block.heading_level || 0);
  }
  const occurrences = [];
  for (const [heading, clauseNo] of headingTexts) {
    let at = compact.indexOf(heading);
    while (at >= 0) {
      occurrences.push({ clause_no: clauseNo, at });
      at = compact.indexOf(heading, at + heading.length);
    }
  }
  occurrences.sort((left, right) => left.at - right.at);
  const lastByClause = new Map();
  for (const item of occurrences) lastByClause.set(item.clause_no, item);
  const candidates = [...lastByClause.values()].sort((left, right) => left.at - right.at);
  const articles = [];
  let unaligned = 0;
  let previousAt = -1;
  for (const entry of candidates) {
    if (entry.at <= previousAt) continue;
    const owner = firstBlockAt(blockSpans, compact, entry.at, map);
    if (!owner) { unaligned += 1; continue; }
    previousAt = entry.at;
    articles.push({ clause_no: entry.clause_no, block_id: owner.block_id, char_start: map[entry.at], heading_level: levelByClause.get(entry.clause_no) || 0 });
  }
  articles.sort((left, right) => left.char_start - right.char_start);
  return { articles, unaligned, heading_count: headings.length, total: (blocks || []).length };
}

// 在 compact 位置上找"覆盖该位置且起始最靠后"的解析块（等价于包含该位置的块）。
// 不能拿块文本去 compact 里 indexOf：同名文本会命中更早的目录副本。
// 也不能要求 exactly 起始于该位置：解析块与 Skill 块粒度不同（标题可能被切成多块）。
// 统一用索引映射把 compact 位置换算成原文偏移，再按区间包含关系取块。
function firstBlockAt(blockSpans, compact, at, map) {
  const rawOffset = map[at];
  let best = null;
  for (const span of blockSpans) {
    const spanStart = map[span.start];
    const spanEnd = map[Math.min(span.end, map.length - 1)] ?? spanStart;
    if (spanStart <= rawOffset && rawOffset < spanEnd + 1) {
      if (!best || spanStart >= best.start) best = { block: span.block, start: spanStart };
    }
  }
  return best ? best.block : null;
}

// 供审查链路使用：返回条边界与对齐质量。任何失败都返回 ok:false，由调用方回退到默认分批。
async function analyzeContract(filePath, document, options = {}) {
  const read = await readBlocks(filePath, options);
  if (!read.ok) return { ok: false, source: read.source, probe: read.probe, message: read.message };
  const analysis = analyzeBlocks(read.data?.blocks, document);
  return { ok: true, source: "skill", skill: read.skill, format: read.data?.format || "",
    needs_ocr: Boolean(read.data?.needs_ocr), block_count: read.data?.block_count || 0, ...analysis };
}

module.exports = { probeSkill, readBlocks, analyzeBlocks, analyzeContract, discoverSkills, loadSkillDescriptor,
  validateBlocksOutput, ARTICLE_PATTERN, BLOCK_OUTPUT_CONTRACT };

