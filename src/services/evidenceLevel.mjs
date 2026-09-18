// 证据强度与风险分级的绑定规则：主进程各产物构造点共用的唯一实现。
//
// 背景：实测导出里 critical 3 条中有 2 条是"未能完整抽取…"这类解析自述，
// 而 location_confidence = 0 的 28 条里有 12 条被判 high。
// 分级没有挂在证据强度上，结果"抓不到东西"比"抓到东西"更容易被评为严重，
// 直接把 critical 这个级别的可信度打掉。
//
// 规则：拿不出原文定位的条目，等级上限为 medium；critical 必须有 resolved 的原文引用。
// 没有定位就不构成"对合同的判断"，只构成"需要人工核验"。
export const LEVEL_ORDER = ["critical", "high", "medium", "low", "info"];

export function capLevelByEvidence(level, anchored) {
  const declared = String(level || "medium");
  if (anchored) return declared;
  return LEVEL_ORDER.indexOf(declared) < LEVEL_ORDER.indexOf("medium") ? "medium" : declared;
}

// 统一的置信度取值：无定位就是 0（而不是给一个看似已定位的弱值）。
export function locationConfidence(anchored, evidenceVerifiable) {
  if (!anchored) return 0;
  return evidenceVerifiable ? 0.94 : 0.6;
}
