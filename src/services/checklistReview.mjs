export const checklistLayers = {
  L1: "主体与效力", L2: "标的与商务", L3: "权利义务",
  L4: "风险分配与救济", L5: "合规与程序", L6: "文本质量与形式"
};
export const checklistStatuses = {
  pass: "自动检查通过", conflict: "疑似冲突", missing: "要素缺失",
  unverifiable: "待核验", not_applicable: "未触发适用条件", skipped: "未执行"
};

export function recordChecklistReview(review, checkId, input) {
  const check = review.checklist_results?.find((item) => item.check_id === checkId);
  if (!check || !review.project?.file_version_id || !review.document?.sha256 || !review.checklist_version) throw new Error("当前清单或合同版本不完整，请重新审查");
  if (!["pass", "not_applicable", "unverifiable"].includes(input.outcome)) throw new Error("复核结论无效");
  const fields = Object.fromEntries(["reviewer", "note", "evidence"].map((key) => [key, String(input[key] || "").trim()]));
  if (Object.values(fields).some((value) => !value)) throw new Error("请填写复核人、材料依据和复核说明");
  const reviewedAt = new Date().toISOString();
  const record = { ...fields, outcome: input.outcome, reviewed_at: reviewedAt,
    file_version_id: review.project.file_version_id, document_hash: review.document.sha256, catalog_version: review.checklist_version };
  const version = `RV-CHECK-${globalThis.crypto.randomUUID()}`;
  return { ...review, review_version_id: version,
    checklist_results: review.checklist_results.map((item) => item.check_id === checkId ? { ...item, human_review: record } : item),
    humanRevisions: [{ review_version_id: version, base_review_version_id: review.review_version_id,
      source_type: "checklist_human_review", created_at: reviewedAt, created_by: record.reviewer,
      reason: record.note, changes: { check_id: checkId, previous: check.human_review || null, current: record } }, ...(review.humanRevisions || [])] };
}

export function locationLabel(location = {}) {
  if (["unresolved", "fallback"].includes(location.location_status) || !location.quote) return "待定位";
  const place = location.page ? `第 ${location.page} 页` : location.block_id || location.source_refs?.some((ref) => ref.block_id) ? "逻辑块定位" : "待定位";
  return location.clause_no ? `${place} · ${location.clause_no}` : place;
}

export function locationPage(location = {}, document = {}) {
  if (["unresolved", "fallback"].includes(location.location_status) || !location.quote) return null;
  if (location.page) return location.page;
  const ref = location.source_refs?.find((item) => item.quote === location.quote) || location;
  return ref.logical_page || document.blocks?.find((b) => b.block_id === ref.block_id)?.logical_page || null;
}

export function quoteRange(text, quote) {
  const needle = String(quote || "").replace(/\s+/g, "");
  if (!needle) return null;
  const map = [];
  let compact = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) { compact += text[index]; map.push(index); }
  }
  const start = compact.indexOf(needle);
  return start < 0 ? null : [map[start], map[start + needle.length - 1] + 1];
}
