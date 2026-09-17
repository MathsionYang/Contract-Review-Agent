export function reconcileDeletedTasks(state, saved = {}) {
  const deletedProjectIds = [...new Set([
    ...(Array.isArray(saved?.deletedProjectIds) ? saved.deletedProjectIds : []),
    ...(Array.isArray(state.deletedProjectIds) ? state.deletedProjectIds : [])
  ])];
  if (!deletedProjectIds.length) return state;

  // 删除标记优先于旧快照，防止异步审查、导出或保存重新写回任务。
  const deleted = new Set(deletedProjectIds);
  const projects = (state.projects || []).filter((project) => !deleted.has(project.project_id));
  const reviews = Object.fromEntries(Object.entries(state.reviews || {}).filter(([id]) => !deleted.has(id)));
  const auditRecords = [...(state.auditRecords || [])];
  const auditIds = new Set(auditRecords.map((entry) => entry.audit_id));
  const deletionAudits = (saved?.auditRecords || []).filter((entry) => (
    entry.event_type === "review_task_deleted" && !auditIds.has(entry.audit_id)
  ));
  return {
    ...state,
    projects,
    reviews,
    deletedProjectIds,
    activeProjectId: projects.some((project) => project.project_id === state.activeProjectId)
      ? state.activeProjectId
      : projects[0]?.project_id || null,
    auditRecords: [...deletionAudits, ...auditRecords]
  };
}

export function deleteReviewTask(state, projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) throw new Error("请指定要删除的审查任务");
  const project = state?.projects?.find((item) => item.project_id === projectId);
  if (!project) throw new Error("审查任务不存在或已被删除");
  const createdAt = new Date().toISOString();
  return reconcileDeletedTasks({
    ...state,
    deletedProjectIds: [...(state.deletedProjectIds || []), projectId],
    auditRecords: [{
      audit_id: `audit_delete_${globalThis.crypto.randomUUID()}`,
      created_at: createdAt,
      actor: "本地法务用户",
      event_type: "review_task_deleted",
      action: "删除审查任务",
      resource: projectId,
      result: "成功",
      detail: `${project.project_name || projectId}：已删除任务及关联审查记录，保留合同原文件、本地文件副本和已导出文件。`
    }, ...(state.auditRecords || [])]
  });
}
