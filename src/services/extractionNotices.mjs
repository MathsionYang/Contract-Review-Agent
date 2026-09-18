// 抽取告警分级：主进程与渲染层共用的唯一名单。
//
// 为什么需要分级：抽取阶段会产生若干告警，但它们语义完全不同，混在一起会让
// "条款事实抽取"阶段被误标成异常（用户看到的是该阶段显示"异常"）：
//   · 真实失败：模型没跑成、该批没抽完 —— 应当作为任务错误上报，阶段可以标红。
//   · 诊断提示：本地校验剔除了模型编造的内容、或截断后已提高预算/拆批重试成功 ——
//     这是保护机制与恢复路径在正常工作，不是流程故障。
//
// 这里刻意用显式白名单，而不是 `code.startsWith("EXTRACTION_")`：
// 前缀通配会把"未来新增的任何 EXTRACTION_*"默认当成故障。
// 反例就在同一个 warnings 数组里：PAGE_LOCATION_UNRESOLVED 因为不匹配前缀而待遇不同，
// 说明原来的前缀过滤并没有设计意图，只是图省事 —— 那是阶段误标的结构性来源。
// 因此未登记的码一律按"诊断提示"处理：宁可少标红，也不要把正常结果说成故障。
//
// 这个文件是纯 ESM 且无任何依赖，主进程用 require() 加载，渲染层用 import 加载。
export const EXTRACTION_FAILURE_CODES = new Set([
  // 模型调用抛出异常，已降级为规则事实
  "EXTRACTION_DEGRADED",
  // 输出预算顶到上限仍被截断，该批未完整抽取
  "EXTRACTION_OUTPUT_BUDGET_EXHAUSTED"
]);

export function isExtractionFailure(code) {
  return EXTRACTION_FAILURE_CODES.has(String(code || ""));
}

// 历史任务里已经持久化进 errors 的诊断提示：重新打开时不该把阶段标红。
// 主进程已不再产生这些错误，这里纯属向后兼容。
export const LEGACY_NOTICE_CODES = new Set([
  "EXTRACTION_FACTS_REJECTED",
  "EXTRACTION_BUDGET_ESCALATED",
  "EXTRACTION_BATCH_TRUNCATED",
  "PAGE_LOCATION_UNRESOLVED",
  // 上下文预算导致的剔除属于"提示"而不是"故障"：流程本身跑完了，只是模型看到的材料变少。
  // 把它们计入失败会把任务误降级为 partial，与"一条被剔除的候选就把抽取阶段标红"是同一类错误。
  "MODEL_CONTEXT_FACTS_OMITTED",
  "MODEL_CONTEXT_EVIDENCE_OMITTED"
]);
