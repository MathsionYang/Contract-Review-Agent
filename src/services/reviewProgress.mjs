export function applyReviewProgress(review, payload, run) {
  if (!review || !run || payload.runId !== run.id || payload.projectId !== run.projectId
    || payload.fileVersionId !== review.project?.file_version_id
    || !Number.isInteger(payload.sequence) || payload.sequence <= run.sequence) return null;
  const update = payload.riskUpdate;
  if (update?.type === "reset") {
    review.risks = [];
    review.task = { ...(review.task || {}), errors: [] };
  }
  if (update?.type === "upsert") {
    const risk = update.risk;
    if (!risk?.risk_id || risk.contract_location?.file_version_id !== review.project.file_version_id) return null;
    const risks = review.risks || (review.risks = []);
    const index = risks.findIndex((item) => item.risk_id === risk.risk_id);
    if (index < 0) risks.push(risk);
    else risks.splice(index, 1, risk);
  }
  run.sequence = payload.sequence;
  if (payload.executionSummary && typeof payload.executionSummary === "object") review.execution_summary = payload.executionSummary;
  run.latestRiskTitle = update?.type === "reset" ? "" : update?.risk?.title || run.latestRiskTitle || "";
  const progress = {
    projectId: payload.projectId,
    runId: payload.runId,
    step: String(payload.step || review.task?.current_step || ""),
    progress: Math.min(Math.max(Number(payload.progress) || 0, 0), 100),
    status: String(payload.status || "running"),
    riskCount: review.risks?.length || 0,
    latestRiskTitle: run.latestRiskTitle
  };
  review.task = { ...(review.task || {}), current_step: progress.step, progress: progress.progress, status: progress.status };
  return progress;
}
