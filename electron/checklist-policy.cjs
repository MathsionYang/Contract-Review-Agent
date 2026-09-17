const catalog = require("./general-checklist-catalog.json");

function coverageFrom(checkResults = []) {
  const counts = { total: checkResults.length, executed: 0, passed: 0, conflict: 0, missing: 0, unverifiable: 0, not_applicable: 0, skipped: 0 };
  for (const check of checkResults) {
    const status = String(check?.status || "skipped");
    const key = status === "pass" ? "passed" : status;
    if (["passed", "conflict", "missing", "unverifiable", "not_applicable", "skipped"].includes(key)) counts[key] += 1;
    else counts.skipped += 1;
    if (["pass", "conflict", "missing"].includes(status)) counts.executed += 1;
  }
  return counts;
}

function validHumanReview(check, review) {
  const record = check.human_review;
  return Boolean(record && ["pass", "not_applicable"].includes(record.outcome)
    && [record.reviewer, record.note, record.evidence].every((v) => typeof v === "string" && v.trim())
    && Number.isFinite(Date.parse(record.reviewed_at))
    && record.file_version_id === review.project?.file_version_id
    && record.document_hash && record.document_hash === review.document?.sha256
    && record.catalog_version === catalog.version);
}

module.exports = { coverageFrom, validHumanReview };
