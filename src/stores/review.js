import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { locationPage, recordChecklistReview } from "../services/checklistReview.mjs";
import { ensureModelIds, findModel } from "../services/managementState.mjs";
import { electronApi } from "../services/electronApi";
import { applyReviewProgress } from "../services/reviewProgress.mjs";
import { knowledgeLabels } from "../services/knowledgeManagement.mjs";
import { createSampleState, knowledgeData, capabilityData, defaultSettings } from "../data/sampleData";
import { buildReviewExecutionConfig, createKnowledgeItem, createManualReviewRisk, createSelectionAnnotation, mergeSettings, removeDemoModels, updateEnterpriseMemory as updateEnterpriseMemoryState, updateLegalSnapshot as updateLegalSnapshotState } from "../services/managementState.mjs";

// 可导出格式必须与 electron/validator.cjs 的 ALLOWED_FORMATS 保持一致。
const EXPORTABLE_FORMATS = ["PDF", "XLSX", "JSON"];

export const useReviewStore = defineStore("review", () => {
  const state = ref(createSampleState());
  const isReady = ref(false);
  const isBusy = ref(false);
  const activeRiskId = ref(null);
  const selectedPage = ref(1);
  const zoom = ref(1);
  const toasts = ref([]);
  const validatorResult = ref(null);
  const reviewProgress = ref(null);
  const chatBusy = ref(false);
  const modelTests = ref({});
  const chatRequestId = ref(null);
  const chatStreamText = ref("");
  const selectedChatModel = ref("");
  const chatContextPreferences = ref({
    includeCurrentPage: true,
    includeSelection: true,
    includeCurrentRisk: true,
    includeKnowledge: true,
    includeMemory: true,
    contextScope: "adjacent_clauses"
  });
  let stopReviewProgress = null;
  let stopChatEvents = null;
  let activeReviewRun = null;

  const activeProject = computed(() => state.value.projects.find((item) => item.project_id === state.value.activeProjectId) || state.value.projects[0] || null);
  const review = computed(() => activeProject.value ? state.value.reviews[activeProject.value.project_id] || null : null);
  const risks = computed(() => review.value?.risks || []);
  const activeRisk = computed(() => activeRiskId.value ? risks.value.find((risk) => risk.risk_id === activeRiskId.value) || null : null);
  const pendingRiskCount = computed(() => risks.value.filter((risk) => ["critical", "high"].includes(risk.risk_level) && risk.human_status === "pending_review").length);
  const selectedRules = computed(() => (state.value.knowledge?.rules || []).filter((item) => item.selected).map((item) => item.file));
  const selectedPolicies = computed(() => (state.value.knowledge?.policies || []).filter((item) => item.selected).map((item) => item.file));
  const reviewExecution = computed(() => review.value?.config?.execution || buildReviewExecutionConfig(state.value.capabilities || {}));
  const activeAnalysisModels = computed(() => (state.value.capabilities?.models || []).filter((model) => (
    model.status === "active" && model.role === "analysis" && model.testStatus === "passed" && model.modelId && model.endpoint
  )));
  const chatSessions = computed(() => review.value?.chat_sessions || []);
  const activeChatSession = computed(() => chatSessions.value.find((session) => session.status === "active") || chatSessions.value[0] || null);
  const chatMessages = computed(() => activeChatSession.value?.messages || []);
  const chatMemoryCandidates = computed(() => (activeChatSession.value?.memory_candidates || []).filter((item) => item.status === "candidate"));

  function notify(message, type = "ok") {
    const id = `${Date.now()}-${Math.random()}`;
    toasts.value.push({ id, message, type });
    window.setTimeout(() => { toasts.value = toasts.value.filter((toast) => toast.id !== id); }, 3600);
  }

  async function persist() {
    try {
      await electronApi.saveState(state.value);
    } catch (error) {
      notify(error.message || "本地保存失败", "warn");
    }
  }

  async function bootstrap() {
    if (activeReviewRun) return;
    if (!stopReviewProgress) {
      stopReviewProgress = electronApi.onReviewProgress((payload = {}) => {
        const projectId = String(payload.projectId || "");
        if (!projectId || projectId !== activeProject.value?.project_id || !review.value) return;
        const next = applyReviewProgress(review.value, payload, activeReviewRun);
        if (next) {
          reviewProgress.value = next;
          if (payload.riskUpdate?.type === "reset") activeRiskId.value = null;
        }
      });
    }
    if (!stopChatEvents) {
      stopChatEvents = electronApi.onChatEvent((payload = {}) => {
        if (payload.type === "start") {
          chatRequestId.value = payload.requestId || null;
          chatStreamText.value = "";
        }
        if (payload.type === "delta") chatStreamText.value += String(payload.delta || "");
        if (["complete", "failed", "cancelled"].includes(payload.type)) chatRequestId.value = null;
      });
    }
    try {
      const saved = await electronApi.loadState();
      const hasSavedWorkspace = Boolean(saved && (
        (Array.isArray(saved.projects) && saved.projects.length)
        || saved.capabilities
        || saved.settings
        || saved.knowledge
        || saved.deletedProjectIds?.length
      ));
      if (hasSavedWorkspace) {
        const savedModels = Array.isArray(saved.capabilities?.models)
          ? ensureModelIds(removeDemoModels(saved.capabilities.models))
          : [];
        state.value = {
          ...createSampleState(),
          ...saved,
          knowledge: saved.knowledge || createSampleState().knowledge,
          // 模型配置只接受本地已保存内容，不能因缺少字段回退到示例模型。
          capabilities: {
            ...(createSampleState().capabilities || {}),
            ...(saved.capabilities || {}),
            models: savedModels
          },
          settings: mergeSettings(defaultSettings, saved.settings || {})
        };
        // 默认导出格式里可能残留已下架的格式（历史版本保存过 DOCX）：
        // 就地清理并回写，使设置自愈，避免导出时因"格式不受支持"被门禁阻断。
        const savedFormats = state.value.settings.defaultExportFormats;
        if (Array.isArray(savedFormats)) {
          const usable = savedFormats.map((format) => String(format).toUpperCase()).filter((format) => EXPORTABLE_FORMATS.includes(format));
          const nextFormats = usable.length ? usable : [...defaultSettings.defaultExportFormats];
          state.value.settings.defaultExportFormats = nextFormats;
          if (nextFormats.join(",") !== savedFormats.map((f) => String(f).toUpperCase()).join(",")) await persist();
        }
        if (JSON.stringify(savedModels) !== JSON.stringify(saved.capabilities?.models || [])) await persist();
      } else {
        state.value = await electronApi.saveState(state.value);
      }
      // Skill 列表以磁盘扫描为唯一事实来源。引导阶段必须扫描一次：
      // 否则能力配置里会一直留着首次启动时播种的示例 Skill 名单，
      // 界面就会显示出根本不存在于 skills/ 目录、也从未被执行的"已启用 Skill"。
      const skillsBeforeScan = JSON.stringify(saved.capabilities?.skills || []);
      await loadClauseSkill();
      // 扫描结果与磁盘上残留的名单不一致时写回，避免每次启动重复迁移。
      if (JSON.stringify(state.value.capabilities?.skills || []) !== skillsBeforeScan) await persist();
      // 用扫描结果刷新本次审查的执行快照，让"已启用 Skill"反映真实目录而不是历史残留。
      if (review.value && syncActiveReviewExecutionSnapshot()) await persist();
    } catch (error) {
      notify(error.message || "本地状态读取失败", "warn");
    } finally {
      isReady.value = true;
    }
  }

  function selectRisk(id) {
    if (!id) return;
    activeRiskId.value = id;
    const risk = risks.value.find((item) => item.risk_id === id);
    const page = locationPage(risk?.contract_location, review.value?.document);
    if (page) selectedPage.value = page;
  }

  function clearRisk() {
    activeRiskId.value = null;
  }

  function resetTaskView() {
    activeRiskId.value = null;
    selectedPage.value = 1;
    zoom.value = 1;
    validatorResult.value = null;
    reviewProgress.value = null;
    chatRequestId.value = null;
    chatStreamText.value = "";
    selectedChatModel.value = "";
  }

  async function selectProject(projectId) {
    if (!state.value.projects.some((project) => project.project_id === projectId)) throw new Error("审查任务不存在或已被删除");
    if (projectId === activeProject.value?.project_id) return;
    if (isBusy.value || chatBusy.value) throw new Error("当前任务正在处理，请稍后切换");
    isBusy.value = true;
    try {
      state.value = await electronApi.saveState({ ...state.value, activeProjectId: projectId });
      resetTaskView();
    } finally {
      isBusy.value = false;
    }
  }

  async function deleteReviewTask(projectId) {
    if (isBusy.value || chatBusy.value) throw new Error("当前任务正在处理，请稍后删除");
    isBusy.value = true;
    const previousActiveId = activeProject.value?.project_id;
    try {
      const nextState = await electronApi.deleteReviewTask(projectId);
      state.value = nextState;
      if (previousActiveId !== activeProject.value?.project_id) resetTaskView();
      notify("审查任务已删除，合同文件及已导出文件已保留");
    } finally {
      isBusy.value = false;
    }
  }

  async function saveChecklistReview(checkId, input) {
    if (isBusy.value || chatBusy.value) throw new Error("审查任务运行中，请稍后复核");
    const nextReview = recordChecklistReview(review.value, checkId, input);
    const nextState = { ...state.value, reviews: { ...state.value.reviews, [activeProject.value.project_id]: nextReview } };
    await electronApi.saveState(nextState);
    state.value = nextState;
    validatorResult.value = null;
    notify("已保存清单复核记录");
  }

  function syncActiveReviewExecutionSnapshot() {
    if (!review.value) return false;
    const next = buildReviewExecutionConfig(
      state.value.capabilities || {},
      review.value.config?.execution || {}
    );
    const previous = JSON.stringify(review.value.config?.execution || null);
    review.value.config = { ...(review.value.config || {}), execution: next };
    review.value.task = { ...(review.value.task || {}), execution: next };
    return previous !== JSON.stringify(next);
  }

  async function syncActiveReviewExecution(options = {}) {
    if (!review.value) return null;
    syncActiveReviewExecutionSnapshot();
    if (options.auditAction) {
      addAudit(options.auditAction, review.value.project?.project_id || "active-review", options.detail || "已更新本次审查实际使用的模型与 Skill");
    }
    review.value.project.updated_at = new Date().toISOString();
    await persist();
    if (options.notifyMessage) notify(options.notifyMessage, "ok");
    return reviewExecution.value;
  }

  function setPage(page) {
    const count = review.value?.document?.pageCount || review.value?.document?.pages?.length || 1;
    selectedPage.value = Math.min(Math.max(Number(page) || 1, 1), count);
  }

  function setZoom(value) {
    zoom.value = Math.min(Math.max(Number(value) || 1, 0.8), 1.35);
  }

  async function applyRiskAction(riskId, action, note = "") {
    if (activeReviewRun || chatBusy.value) { notify("审查正在运行，请结束后再处理风险", "warn"); return; }
    const target = risks.value.find((risk) => risk.risk_id === riskId);
    if (!target) return;
    const previous = target.human_status;
    const nextStatus = { accepted: "accepted", false_positive: "false_positive", modified: "modified", deferred: "deferred", deleted: "deleted" }[action] || action;
    target.human_status = nextStatus;
    if (action === "accepted") target.conclusion_status = "confirmed";
    if (action === "false_positive") target.conclusion_status = "rejected";
    if (action === "deleted") target.conclusion_status = "rejected";
    review.value.humanRevisions = review.value.humanRevisions || [];
    review.value.humanRevisions.unshift({
      review_version_id: `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-HR-${String(review.value.humanRevisions.length + 1).padStart(2, "0")}`,
      source_type: "human_revision",
      base_review_version_id: review.value.review_version_id,
      risk_id: riskId,
      created_by: "法务用户",
      created_at: new Date().toISOString(),
      reason: note || `人工处理：${action}`,
      changes: { human_status: [previous, nextStatus] }
    });
    review.value.review_version_id = review.value.humanRevisions[0].review_version_id;
    review.value.task.status = pendingRiskCount.value ? "waiting_confirmation" : "validating";
    review.value.task.progress = pendingRiskCount.value ? 86 : 100;
    await persist();
    notify(action === "accepted" ? "已接受该风险，已生成新的审查版本" : "已保存人工处理结果", "ok");
  }

  async function saveSelectionAnnotation(input) {
    if (activeReviewRun) throw new Error("审查正在运行，请结束后再标记选区");
    if (!review.value) throw new Error("当前没有可标记的审查版本");
    const annotation = createSelectionAnnotation(input);
    review.value.annotations = review.value.annotations || [];
    const exists = review.value.annotations.findIndex((item) => item.annotation_id === annotation.annotation_id);
    if (exists >= 0) review.value.annotations[exists] = annotation;
    else review.value.annotations.unshift(annotation);
    addAudit("新增人工选区标记", annotation.annotation_id, `第 ${annotation.page} 页 · ${annotation.clause_no || "未标条款"}`);
    await persist();
    notify("选区已高亮并保存", "ok");
    return annotation;
  }

  async function reviewSelection(input) {
    if (activeReviewRun) throw new Error("审查正在运行，请结束后再局部审查");
    if (!review.value) throw new Error("当前没有可局部审查的审查版本");
    const annotation = await saveSelectionAnnotation(input);
    const risk = createManualReviewRisk({
      selection: annotation,
      reviewType: input.reviewType,
      topic: input.topic,
      contextScope: input.contextScope,
      riskLevel: input.riskLevel
    });
    review.value.risks = [risk, ...(review.value.risks || [])];
    review.value.humanRevisions = review.value.humanRevisions || [];
    review.value.humanRevisions.unshift({
      review_version_id: `RV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-SEL-${String(review.value.humanRevisions.length + 1).padStart(2, "0")}`,
      source_type: "manual_selection_review",
      base_review_version_id: review.value.review_version_id,
      risk_id: risk.risk_id,
      selection_annotation_id: annotation.annotation_id,
      created_by: "法务用户",
      created_at: new Date().toISOString(),
      reason: `局部审查：${input.reviewType || "法律风险"}`,
      changes: { risk_id: risk.risk_id, conclusion_status: "needs_verification" }
    });
    review.value.review_version_id = review.value.humanRevisions[0].review_version_id;
    review.value.task = { ...(review.value.task || {}), status: "waiting_confirmation", progress: 86 };
    activeRiskId.value = risk.risk_id;
    selectedPage.value = annotation.page;
    await persist();
    addAudit("提交局部审查", risk.risk_id, `已绑定第 ${annotation.page} 页选区 ${annotation.text_hash}`);
    await persist();
    notify("局部审查候选已加入风险清单，等待人工核验", "ok");
    return risk;
  }

  async function importContract(options) {
    const { onImported, ...importOptions } = options || {};
    isBusy.value = true;
    try {
      const result = await electronApi.importContract({
        ...importOptions,
        bootstrapState: {
          knowledge: state.value.knowledge,
          capabilities: state.value.capabilities,
          settings: state.value.settings
        }
      });
      state.value = result.state;
      state.value.knowledge = state.value.knowledge || JSON.parse(JSON.stringify(knowledgeData));
      state.value.capabilities = state.value.capabilities || JSON.parse(JSON.stringify(capabilityData));
      syncActiveReviewExecutionSnapshot();
      await persist();
      activeRiskId.value = null;
      selectedPage.value = 1;
      reviewProgress.value = {
        projectId: result.project?.project_id,
        step: result.review?.task?.current_step || "parse",
        progress: Number(result.review?.task?.progress || 0),
        status: result.review?.task?.status || "queued",
        riskCount: result.review?.risks?.length || 0
      };
      if (typeof onImported === "function") onImported(result);
      notify(`已导入 ${result.project.file_name}，开始执行本地审查`, "ok");
      await runReview();
      return result;
    } catch (error) {
      notify(error.message || "合同导入失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function runReview() {
    if (!review.value) return null;
    if (activeReviewRun || chatBusy.value) throw new Error("审查或对话正在运行，请稍后重试");
    syncActiveReviewExecutionSnapshot();
    activeReviewRun = { id: globalThis.crypto.randomUUID(), projectId: activeProject.value.project_id, sequence: 0 };
    validatorResult.value = null;
    isBusy.value = true;
    try {
      const result = await electronApi.runReview({
        projectId: activeProject.value?.project_id,
        runId: activeReviewRun.id,
        review: review.value
      });
      if (result.state) state.value = result.state;
      else if (result.review && activeProject.value) state.value.reviews[activeProject.value.project_id] = result.review;
      const status = result.review?.task?.status;
      reviewProgress.value = result.review ? {
        projectId: result.review.project?.project_id || activeProject.value?.project_id,
        step: result.review.task?.current_step || "persist",
        progress: Number(result.review.task?.progress || 0),
        status: status || "unknown",
        riskCount: result.review.risks?.length || 0
      } : null;
      notify(status === "completed" ? `审查完成，生成 ${result.review.risks?.length || 0} 条风险`
        : status === "cancelled" ? `审查已停止，保留 ${result.review.risks?.length || 0} 条候选风险`
        : `审查${status === "partial" ? "部分完成" : "未完成"}，请查看任务状态`, status === "completed" ? "ok" : "warn");
      return result;
    } catch (error) {
      notify(error.message || "合同审查执行失败", "warn");
      throw error;
    } finally {
      activeReviewRun = null;
      isBusy.value = false;
    }
  }

  // 只请求中断当前项目的审查；主进程中断模型与检索后，已发布的候选风险会随取消结果一起保存。
  async function cancelReview() {
    if (!activeReviewRun) return null;
    // 立即进入"正在停止"，避免用户在等待主进程收尾期间以为按钮没有生效。
    if (review.value?.task) review.value.task = { ...review.value.task, status: "cancelling" };
    if (reviewProgress.value) reviewProgress.value = { ...reviewProgress.value, status: "cancelling" };
    try {
      const result = await electronApi.cancelReview({ projectId: activeReviewRun.projectId });
      if (!result?.ok) {
        if (review.value?.task) review.value.task = { ...review.value.task, status: "running" };
        notify(result?.message || "当前没有正在运行的审查任务", "warn");
      } else notify("正在停止审查，已生成的风险会保留", "warn");
      return result;
    } catch (error) {
      if (review.value?.task) review.value.task = { ...review.value.task, status: "running" };
      notify(error.message || "无法停止审查任务", "warn");
      return null;
    }
  }

  function setChatModel(modelName) {
    selectedChatModel.value = String(modelName || "");
  }

  function updateChatContextPreferences(patch) {
    chatContextPreferences.value = { ...chatContextPreferences.value, ...patch };
  }

  async function chatReview(options = {}) {
    if (isBusy.value || chatBusy.value) { notify("审查或对话正在运行，请稍后重试", "warn"); return null; }
    if (!review.value || !activeProject.value) return null;
    if (!activeAnalysisModels.value.length) {
      notify("请先配置并启用通过校验的 analysis 模型", "warn");
      return null;
    }
    chatBusy.value = true;
    chatStreamText.value = "";
    try {
      const result = await electronApi.chatReview({
        projectId: activeProject.value.project_id,
        modelName: options.modelName || selectedChatModel.value || reviewExecution.value.models?.analysis?.name,
        currentPage: selectedPage.value,
        activeRiskId: activeRiskId.value,
        selectionRef: options.selectionRef,
        selection: options.selection,
        userInput: options.userInput,
        contextPreferences: { ...chatContextPreferences.value, ...(options.contextPreferences || {}) },
        tokenBudget: options.tokenBudget
      });
      if (result?.state) state.value = result.state;
      if (result?.requestId) chatRequestId.value = result.requestId;
      if (!result?.ok) {
        notify(result.message || "对话审核未完成，可重试", "warn");
        return result;
      }
      if (result.response?.risk_refs?.length) selectRisk(result.response.risk_refs[0]);
      notify(result.response?.intent === "create_risk" ? `已加入 ${result.response.risk_refs.length} 条待核验风险` : result.response?.intent === "local_review" ? "已生成局部审查候选" : "对话审核完成", "ok");
      return result;
    } catch (error) {
      notify(error.message || "对话审核失败", "warn");
      throw error;
    } finally {
      chatBusy.value = false;
      chatRequestId.value = null;
    }
  }

  async function retryChat(options = {}) {
    if (isBusy.value || chatBusy.value) { notify("审查或对话正在运行，请稍后重试", "warn"); return null; }
    if (!activeProject.value) return null;
    chatBusy.value = true;
    chatStreamText.value = "";
    try {
      const result = await electronApi.retryChat({
        projectId: activeProject.value.project_id,
        sessionId: options.sessionId || activeChatSession.value?.chat_session_id,
        messageId: options.messageId,
        modelName: options.modelName || selectedChatModel.value,
        tokenBudget: options.tokenBudget
      });
      if (result?.state) state.value = result.state;
      if (!result?.ok) notify(result.message || "对话重试未完成", "warn");
      else notify("已使用相同上下文重新审核", "ok");
      return result;
    } finally {
      chatBusy.value = false;
      chatRequestId.value = null;
    }
  }

  async function cancelChat() {
    if (!chatRequestId.value) return null;
    try { return await electronApi.cancelChat({ requestId: chatRequestId.value }); } catch (error) { notify(error.message || "无法停止对话审核", "warn"); return null; }
  }

  async function confirmMemoryCandidate(options = {}) {
    if (!activeProject.value || !activeChatSession.value) return null;
    const result = await electronApi.confirmMemory({
      projectId: activeProject.value.project_id,
      sessionId: activeChatSession.value.chat_session_id,
      candidateId: options.candidateId,
      edited: options.edited,
      resolution: options.resolution,
      actorId: "local-user"
    });
    if (result?.state) state.value = result.state;
    if (result?.ok) notify(result.keptExisting ? "已保留现有企业记忆" : "企业记忆已确认并写入本地知识库", "ok");
    else notify(result?.message || "企业记忆仍需处理", "warn");
    return result;
  }

  async function dismissMemoryCandidate(candidateId, reason = "用户放弃") {
    if (!activeProject.value || !activeChatSession.value) return null;
    const result = await electronApi.dismissMemory({
      projectId: activeProject.value.project_id,
      sessionId: activeChatSession.value.chat_session_id,
      candidateId,
      reason,
      actorId: "local-user"
    });
    if (result?.state) state.value = result.state;
    if (result?.ok) notify("已放弃该企业记忆候选", "ok");
    return result;
  }

  async function importKnowledgeFiles(kind, files) {
    if (isBusy.value || chatBusy.value) throw new Error("当前任务正在处理，请稍后导入");
    if (!Array.isArray(files) || !files.length) return null;
    isBusy.value = true;
    try {
      const result = await electronApi.importKnowledgeFiles({
        kind,
        files,
        bootstrapState: {
          knowledge: state.value.knowledge,
          capabilities: state.value.capabilities,
          settings: state.value.settings
        }
      });
      if (result.state) state.value = result.state;
      if (result.errors?.length) {
        notify(`已导入 ${result.items?.length || 0} 个文件，${result.errors.length} 个文件失败`, "warn");
      } else {
        notify(`已导入 ${result.items?.length || 0} 个知识文件`, "ok");
      }
      return result;
    } catch (error) {
      notify(error.message || "知识文件导入失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function importLegalSnapshot(options = {}) {
    if (isBusy.value || chatBusy.value) throw new Error("当前任务正在处理，请稍后导入");
    isBusy.value = true;
    try {
      const result = await electronApi.importLegalSnapshot({
        ...options,
        bootstrapState: {
          knowledge: state.value.knowledge,
          capabilities: state.value.capabilities,
          settings: state.value.settings
        }
      });
      if (!result.canceled && result.state) state.value = result.state;
      if (!result.canceled) notify(`已导入法律快照 ${result.snapshot?.name || ""}`, "ok");
      return result;
    } catch (error) {
      notify(error.message || "法律快照导入失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function verifyLegalRealtime(options = {}) {
    isBusy.value = true;
    try {
      const result = await electronApi.verifyLegalRealtime(options);
      if (result.state) state.value = result.state;
      if (options.snapshotId) {
        const snapshot = (state.value.knowledge?.legalSnapshots || []).find((item) => item.id === options.snapshotId);
        if (snapshot) {
          snapshot.realtime_verification = {
            status: result.status,
            error_code: result.errorCode || null,
            message: result.message || "",
            verified_at: new Date().toISOString(),
            sources: Array.isArray(result.sources) ? result.sources : []
          };
          await persist();
        }
      }
      notify(result.status === "verified" ? "实时法律来源核验完成" : (result.message || "实时法律来源未完成"), result.status === "verified" ? "ok" : "warn");
      return result;
    } catch (error) {
      notify(error.message || "实时法律来源核验失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function saveConfig(config) {
    if (!review.value) throw new Error("请先选择一个审查任务");
    if (isBusy.value || chatBusy.value) throw new Error("审查正在处理，请稍后保存配置");
    if (config.snapshot?.id) {
      const snapshot = (state.value.knowledge?.legalSnapshots || []).find((item) => item.id === config.snapshot.id);
      if (!snapshot || snapshot.status !== "published") throw new Error("只能绑定已发布且未删除的法律快照");
      config = { ...config, snapshot: { id: snapshot.id, status: snapshot.status } };
    }
    const execution = config.execution || review.value.config?.execution || buildReviewExecutionConfig(state.value.capabilities || {});
    const projectId = activeProject.value.project_id;
    const nextReview = {
      ...review.value,
      config: { ...review.value.config, ...config, execution },
      task: { ...(review.value.task || {}), execution },
      project: { ...review.value.project, ...(config.reviewMode ? { review_mode: config.reviewMode } : {}), updated_at: new Date().toISOString() }
    };
    isBusy.value = true;
    try {
      state.value = await electronApi.saveState({ ...state.value, reviews: { ...state.value.reviews, [projectId]: nextReview } });
      validatorResult.value = null;
      notify("本次审查配置已保存", "ok");
    } finally {
      isBusy.value = false;
    }
  }

  async function updateLegalSnapshot(snapshotId, patch = {}, options = {}) {
    if (isBusy.value || chatBusy.value) throw new Error("审查正在处理，请稍后发布或编辑快照");
    const snapshots = state.value.knowledge?.legalSnapshots || [];
    const nextSnapshots = updateLegalSnapshotState(snapshots, snapshotId, patch);
    const snapshot = nextSnapshots.find((item) => item.id === snapshotId);
    const publishing = snapshots.find((item) => item.id === snapshotId)?.status !== "published" && snapshot.status === "published";
    if (publishing && !options.confirmPublication) throw new Error("请先确认已核对快照内容及适用范围");
    if (options.bindToCurrentReview && (!review.value || snapshot.status !== "published")) throw new Error("只有已发布快照可以绑定到当前审查任务");
    const reviews = Object.fromEntries(Object.entries(state.value.reviews || {}).map(([id, reviewItem]) => {
      if (reviewItem.config?.snapshot?.id === snapshot.id) {
        return [id, { ...reviewItem, config: { ...reviewItem.config, snapshot: { ...reviewItem.config.snapshot, status: snapshot.status } } }];
      }
      return [id, reviewItem];
    }));
    if (options.bindToCurrentReview) {
      const id = activeProject.value.project_id;
      reviews[id] = { ...reviews[id], config: { ...reviews[id].config, snapshot: { id: snapshot.id, status: snapshot.status } } };
    }
    const auditRecord = {
      audit_id: `audit_snapshot_${globalThis.crypto.randomUUID()}`,
      created_at: new Date().toISOString(), actor: "法务用户", result: "成功",
      action: publishing ? "发布法律快照" : "编辑法律快照", resource: snapshot.id,
      detail: `${snapshot.name} · ${snapshot.coverage}${options.bindToCurrentReview ? ` · 绑定审查 ${activeProject.value.project_id}` : ""}`
    };
    isBusy.value = true;
    try {
      state.value = await electronApi.saveState({ ...state.value, knowledge: { ...state.value.knowledge, legalSnapshots: nextSnapshots }, reviews, auditRecords: [auditRecord, ...(state.value.auditRecords || [])] });
      validatorResult.value = null;
      notify(options.bindToCurrentReview ? "法律快照已发布并绑定到当前审查" : publishing ? "法律快照已发布" : "法律快照已更新", "ok");
      return snapshot;
    } finally {
      isBusy.value = false;
    }
  }

  async function updateEnterpriseMemory(originalContent, patch = {}) {
    const memory = state.value.knowledge?.memory || [];
    const nextMemory = updateEnterpriseMemoryState(memory, originalContent, patch);
    state.value.knowledge.memory = nextMemory;
    const item = nextMemory.find((entry) => entry.content === String(patch.content || originalContent).trim());
    addAudit("编辑企业记忆", item.content, "已更新记忆内容、作用域、类型、状态或置信度");
    await persist();
    notify("企业记忆已更新", "ok");
    return item;
  }

  async function toggleKnowledge(type, index) {
    if (isBusy.value || chatBusy.value) { notify("审查正在处理，请稍后修改知识选择", "warn"); return; }
    const items = state.value.knowledge?.[type];
    if (!items?.[index]) return;
    items[index].selected = !items[index].selected;
    if (!review.value) await persist();
    else if (type === "rules") await saveConfig({ rules: selectedRules.value });
    else if (type === "policies") await saveConfig({ policies: selectedPolicies.value });
  }

  function addAudit(action, resource, detail) {
    state.value.auditRecords = [{
      audit_id: `audit_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      created_at: new Date().toISOString(),
      actor: "法务用户",
      action,
      resource,
      result: "成功",
      detail
    }, ...(state.value.auditRecords || [])];
  }

  async function addKnowledge(type, payload) {
    if (!["rules", "policies"].includes(type)) return null;
    const items = state.value.knowledge?.[type] || [];
    const item = { ...createKnowledgeItem(type, payload), entry_id: globalThis.crypto.randomUUID() };
    if (items.some((source) => source.file === item.file)) {
      throw new Error("同名知识文件已经存在");
    }
    items.unshift(item);
    addAudit(type === "rules" ? "新增确定性规则" : "新增企业制度", item.file, "已加入知识库，默认未勾选");
    await persist();
    notify("知识文件已新增", "ok");
    return item;
  }

  async function updateKnowledge(type, originalFile, patch) {
    if (!["rules", "policies"].includes(type)) return null;
    const items = state.value.knowledge?.[type] || [];
    const index = items.findIndex((item) => item.file === originalFile);
    if (index < 0) return null;
    const nextFile = String(patch.file || originalFile).trim();
    if (!nextFile) throw new Error("文件名不能为空");
    if (nextFile !== originalFile && items.some((item) => item.file === nextFile)) {
      throw new Error("同名知识文件已经存在");
    }
    items[index] = { ...items[index], ...patch, file: nextFile };
    for (const reviewItem of Object.values(state.value.reviews || {})) {
      const configFiles = reviewItem.config?.[type] || [];
      if (configFiles.includes(originalFile)) {
        reviewItem.config[type] = configFiles.map((file) => file === originalFile ? nextFile : file);
      }
    }
    addAudit(type === "rules" ? "编辑确定性规则" : "编辑企业制度", nextFile, "已更新文件摘要与元数据");
    await persist();
    notify("知识文件已更新", "ok");
    return items[index];
  }

  async function deleteKnowledge(type, keys) {
    if (isBusy.value || chatBusy.value) throw new Error("当前任务正在处理，请稍后删除");
    isBusy.value = true;
    try {
      state.value = await electronApi.deleteKnowledge({ kind: type, keys, bootstrapState: { knowledge: state.value.knowledge } });
      validatorResult.value = null;
      notify(`${knowledgeLabels[type]}已删除，历史证据和磁盘文件已保留`, "ok");
    } finally {
      isBusy.value = false;
    }
  }

  function isModelTesting(reference) {
    const model = findModel(state.value.capabilities?.models || [], reference);
    return Boolean(model && modelTests.value[model.configId]);
  }

  async function commitModel(current, next, action, detail) {
    const configId = current?.configId || next.configId;
    const auditRecord = {
      audit_id: `audit_${globalThis.crypto.randomUUID()}`, created_at: new Date().toISOString(),
      actor: "法务用户", action, resource: next?.name || current.name, result: "成功", detail
    };
    const saved = await electronApi.updateModel({
      configId, expectedRevision: current ? current.configRevision || "" : null,
      model: next ? { ...next, configId, configRevision: globalThis.crypto.randomUUID() } : null,
      auditRecord
    });
    const models = state.value.capabilities?.models || [];
    state.value.capabilities = { ...(state.value.capabilities || {}), models: saved.model
      ? models.some((item) => item.configId === configId) ? models.map((item) => item.configId === configId ? saved.model : item) : [saved.model, ...models]
      : models.filter((item) => item.configId !== configId) };
    state.value.auditRecords = [auditRecord, ...(state.value.auditRecords || []).filter((item) => item.audit_id !== auditRecord.audit_id)];
    // In-flight tasks retain the execution snapshot they started with.
    if (!isBusy.value && !chatBusy.value) syncActiveReviewExecutionSnapshot();
    return saved.model;
  }

  async function saveModel(model) {
    const name = String(model.name || "").trim();
    if (!name) throw new Error("模型名称不能为空");
    if (!String(model.modelId || "").trim()) throw new Error("模型标识不能为空");
    if (!String(model.endpoint || "").trim()) throw new Error("API 地址不能为空");
    const current = model.configId ? findModel(state.value.capabilities?.models || [], model.configId) : null;
    if (model.configId && !current) throw new Error("待编辑的模型配置不存在，请刷新列表");
    // 防御性丢弃敏感字段，避免未来其他调用方误把 API Key 写入业务状态。
    const { apiKey: _apiKey, ...safeModel } = model;
    const next = {
      ...safeModel,
      configId: current?.configId || globalThis.crypto.randomUUID(),
      name,
      modelId: String(model.modelId).trim(),
      endpoint: String(model.endpoint).trim(),
      version: String(model.version || "cfg-v1").trim(),
      // 保存后统一停用，真实连接测试通过后再由用户明确启用。
      status: "disabled",
      // 修改配置后不能沿用旧的连接测试结果。
      testStatus: "untested",
      testKind: "",
      testMessage: "",
      lastTestedAt: "",
      testLatencyMs: 0,
      source: "manual"
    };
    const saved = await commitModel(current, next, "保存模型配置", `${next.provider || "自定义服务"} · ${next.role || "未指定角色"}`);
    delete modelTests.value[saved.configId];
    notify("模型配置已保存，请测试连接后启用", "ok");
    return saved;
  }

  async function deleteModel(name) {
    const current = findModel(state.value.capabilities?.models || [], name);
    if (!current) return;
    await commitModel(current, null, "删除模型配置", "已从模型角色列表移除");
    delete modelTests.value[current.configId];
    notify("模型配置已删除", "ok");
  }

  async function toggleModel(name) {
    const model = findModel(state.value.capabilities?.models || [], name);
    if (!model) return;
    if (isModelTesting(model.configId)) { notify("该模型正在测试连接，请稍后启用或停用", "warn"); return false; }
    if (model.status !== "active" && model.testStatus !== "passed") {
      notify("请先测试连接，通过后才能启用模型", "warn");
      return false;
    }
    const status = model.status === "active" ? "disabled" : "active";
    await commitModel(model, { ...model, status }, status === "active" ? "启用模型配置" : "停用模型配置", `当前状态：${status === "active" ? "启用" : "停用"}`);
    notify(status === "active" ? "模型已启用" : "模型已停用", "ok");
    return true;
  }

  async function validateModel(name) {
    const model = findModel(state.value.capabilities?.models || [], name);
    if (!model || isModelTesting(model.configId)) return false;
    const configId = model.configId;
    const revision = model.configRevision || "";
    const requestId = globalThis.crypto.randomUUID();
    modelTests.value[configId] = requestId;
    try {
      let result;
      try { result = await electronApi.testModelConnection({ configId, expectedRevision: revision }); }
      catch (error) { result = { ok: false, message: error.message || "连通性测试失败" }; }
      const current = findModel(state.value.capabilities?.models || [], configId);
      if (!current || (current.configRevision || "") !== revision || modelTests.value[configId] !== requestId) return false;
      const valid = result?.ok === true;
      const next = {
        ...current, testStatus: valid ? "passed" : "failed", testKind: "remote",
        testMessage: result?.message || (valid ? "连接测试通过" : "连通性测试失败"),
        lastTestedAt: result?.testedAt || new Date().toISOString(), testLatencyMs: result?.latencyMs || 0,
        status: valid ? current.status : "disabled"
      };
      try { await commitModel(current, next, "测试模型连接", next.testMessage); }
      catch (error) {
        const latest = findModel(state.value.capabilities?.models || [], configId);
        if (!latest || (latest.configRevision || "") !== revision) return false;
        latest.testStatus = "untested";
        latest.status = "disabled";
        latest.testMessage = "连接测试结果未能保存，请重新测试";
        if (!isBusy.value && !chatBusy.value) syncActiveReviewExecutionSnapshot();
        throw error;
      }
      notify(next.testMessage, valid ? "ok" : "warn");
      return valid;
    } finally {
      if (modelTests.value[configId] === requestId) delete modelTests.value[configId];
    }
  }

  // 审查 Skill 列表以磁盘扫描结果为准：不写死名称，升级 Skill 只需替换目录。
  // 已保存的启停状态按名称保留，新出现的 Skill 默认启用，已移除的自动消失。
  const clauseSkill = ref({ available: false, reason: "unknown", discovered: [] });
  async function loadClauseSkill(options = {}) {
    try {
      const status = await electronApi.clauseSkillStatus({ refresh: Boolean(options.refresh) });
      clauseSkill.value = status || { available: false, discovered: [] };
      const discovered = Array.isArray(status?.discovered) ? status.discovered : [];
      const previous = new Map((state.value.capabilities?.skills || []).map((item) => [item.name, item]));
      state.value.capabilities = {
        ...(state.value.capabilities || {}),
        skills: discovered.map((skill) => ({
          name: skill.name,
          version: skill.version || "",
          scope: skill.declares_blocks ? "条款抽取" : "全部合同",
          description: skill.description || "",
          status: previous.get(skill.name)?.status === "disabled" ? "disabled" : "enabled",
          source: "local",
          directory: skill.directory,
          contract_source: skill.contract_source,
          available: Boolean(status?.available && status?.skill?.name === skill.name)
        }))
      };
      return status;
    } catch (error) {
      clauseSkill.value = { available: false, reason: "probe_failed", message: error.message, discovered: [] };
      return clauseSkill.value;
    }
  }

  async function toggleSkill(name) {
    const skill = (state.value.capabilities?.skills || []).find((item) => item.name === name);
    if (!skill) return;
    if (skill.status === "isolated" || skill.status === "validating") {
      notify("该 Skill 尚未通过校验，暂不能用于审查", "warn");
      return;
    }
    skill.status = skill.status === "enabled" ? "disabled" : "enabled";
    syncActiveReviewExecutionSnapshot();
    addAudit(skill.status === "enabled" ? "启用审查 Skill" : "停用审查 Skill", name, `本次审查执行配置已同步：${skill.status === "enabled" ? "纳入" : "移出"}`);
    await persist();
    notify(skill.status === "enabled" ? "Skill 已启用并纳入本次审查" : "Skill 已停用并移出本次审查", "ok");
  }

  async function updateSettings(patch) {
    state.value.settings = mergeSettings(mergeSettings(defaultSettings, state.value.settings || {}), patch);
    addAudit("更新系统设置", "local-settings", Object.keys(patch).join("、"));
    await persist();
    notify("系统设置已保存", "ok");
  }

  async function runValidator(formats = ["PDF", "XLSX", "JSON"], mode = "formal") {
    if (!review.value) return null;
    if (isBusy.value || chatBusy.value) throw new Error("任务正在处理，请完成后再校验导出");
    isBusy.value = true;
    try {
      validatorResult.value = await electronApi.validateExport({ review: review.value, formats, mode });
      return validatorResult.value;
    } finally {
      isBusy.value = false;
    }
  }

  async function runExport(formats, mode = "formal") {
    if (!review.value) return null;
    if (isBusy.value || chatBusy.value) throw new Error("任务正在处理，请完成后再导出");
    isBusy.value = true;
    try {
      const result = await electronApi.exportReview({ review: review.value, formats, mode });
      if (result.state) state.value = result.state;
      validatorResult.value = result.validation;
      if (result.records?.length) notify(`已生成 ${result.records.length} 个${mode === "draft" ? "草稿" : "正式报告"}文件`, "ok");
      return result;
    } catch (error) {
      notify(error.message || "导出失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  function resetSample() {
    state.value = createSampleState();
    activeRiskId.value = null;
    selectedPage.value = 1;
    validatorResult.value = null;
    reviewProgress.value = null;
  }

  return {
    state, isReady, isBusy, activeRiskId, selectedPage, zoom, toasts, validatorResult, reviewProgress,
    chatBusy, chatRequestId, chatStreamText, selectedChatModel, chatContextPreferences, isModelTesting,
    activeProject, review, risks, activeRisk, pendingRiskCount, selectedRules, selectedPolicies, reviewExecution,
    activeAnalysisModels, chatSessions, activeChatSession, chatMessages, chatMemoryCandidates,
    bootstrap, persist, notify, selectRisk, clearRisk, selectProject, deleteReviewTask, saveChecklistReview, syncActiveReviewExecution, setPage, setZoom, applyRiskAction, importContract, runReview, cancelReview, importKnowledgeFiles, importLegalSnapshot, verifyLegalRealtime,
    saveConfig, updateLegalSnapshot, updateEnterpriseMemory, toggleKnowledge, addKnowledge, updateKnowledge, deleteKnowledge, saveModel, deleteModel,
    saveSelectionAnnotation, reviewSelection, setChatModel, updateChatContextPreferences, chatReview, retryChat, cancelChat, confirmMemoryCandidate, dismissMemoryCandidate,
    toggleModel, validateModel, toggleSkill, loadClauseSkill, clauseSkill, updateSettings, runValidator, runExport, resetSample
  };
});
