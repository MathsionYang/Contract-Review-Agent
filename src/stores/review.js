import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { electronApi } from "../services/electronApi";
import { createSampleState, knowledgeData, capabilityData, defaultSettings } from "../data/sampleData";
import { buildReviewExecutionConfig, createKnowledgeItem, createManualReviewRisk, createSelectionAnnotation, mergeSettings, removeKnowledgeItems, removeModel, updateEnterpriseMemory as updateEnterpriseMemoryState, updateLegalSnapshot as updateLegalSnapshotState, upsertModel } from "../services/managementState.mjs";

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
  let stopReviewProgress = null;

  const activeProject = computed(() => state.value.projects.find((item) => item.project_id === state.value.activeProjectId) || state.value.projects[0] || null);
  const review = computed(() => activeProject.value ? state.value.reviews[activeProject.value.project_id] || null : null);
  const risks = computed(() => review.value?.risks || []);
  const activeRisk = computed(() => activeRiskId.value ? risks.value.find((risk) => risk.risk_id === activeRiskId.value) || null : null);
  const pendingRiskCount = computed(() => risks.value.filter((risk) => ["critical", "high"].includes(risk.risk_level) && risk.human_status === "pending_review").length);
  const selectedRules = computed(() => (state.value.knowledge?.rules || []).filter((item) => item.selected).map((item) => item.file));
  const selectedPolicies = computed(() => (state.value.knowledge?.policies || []).filter((item) => item.selected).map((item) => item.file));
  const reviewExecution = computed(() => review.value?.config?.execution || buildReviewExecutionConfig(state.value.capabilities || {}));

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
    if (!stopReviewProgress) {
      stopReviewProgress = electronApi.onReviewProgress((payload = {}) => {
        const projectId = String(payload.projectId || "");
        if (!projectId || projectId !== activeProject.value?.project_id || !review.value) return;
        reviewProgress.value = {
          projectId,
          step: String(payload.step || review.value.task?.current_step || ""),
          progress: Math.min(Math.max(Number(payload.progress) || 0, 0), 100),
          status: String(payload.status || "running")
        };
        review.value.task = {
          ...(review.value.task || {}),
          current_step: reviewProgress.value.step,
          progress: reviewProgress.value.progress,
          status: reviewProgress.value.status
        };
      });
    }
    try {
      const saved = await electronApi.loadState();
      if (saved && Array.isArray(saved.projects) && saved.projects.length) {
        state.value = {
          ...createSampleState(),
          ...saved,
          knowledge: saved.knowledge || createSampleState().knowledge,
          capabilities: saved.capabilities || createSampleState().capabilities,
          settings: mergeSettings(defaultSettings, saved.settings || {})
        };
      }
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
    if (risk?.contract_location?.page) selectedPage.value = risk.contract_location.page;
  }

  function clearRisk() {
    activeRiskId.value = null;
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
    isBusy.value = true;
    try {
      const result = await electronApi.importContract({
        ...options,
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
    isBusy.value = true;
    try {
      const result = await electronApi.runReview({
        projectId: activeProject.value?.project_id,
        review: review.value
      });
      if (result.state) state.value = result.state;
      else if (result.review && activeProject.value) state.value.reviews[activeProject.value.project_id] = result.review;
      const status = result.review?.task?.status;
      reviewProgress.value = result.review ? {
        projectId: result.review.project?.project_id || activeProject.value?.project_id,
        step: result.review.task?.current_step || "persist",
        progress: Number(result.review.task?.progress || 0),
        status: status || "unknown"
      } : null;
      notify(status === "completed" ? `审查完成，生成 ${result.review.risks?.length || 0} 条风险` : `审查${status === "partial" ? "部分完成" : "未完成"}，请查看任务状态`, status === "completed" ? "ok" : "warn");
      return result;
    } catch (error) {
      notify(error.message || "合同审查执行失败", "warn");
      throw error;
    } finally {
      isBusy.value = false;
    }
  }

  async function importKnowledgeFiles(kind, files) {
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
      if (result.state) state.value = result.state;
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
    if (!review.value) return;
    const execution = config.execution || review.value.config?.execution || buildReviewExecutionConfig(state.value.capabilities || {});
    review.value.config = { ...review.value.config, ...config, execution };
    review.value.task = { ...(review.value.task || {}), execution };
    if (config.reviewMode && review.value.project) review.value.project.review_mode = config.reviewMode;
    review.value.project.updated_at = new Date().toISOString();
    await persist();
    notify("本次审查配置已保存", "ok");
  }

  async function updateLegalSnapshot(snapshotId, patch = {}) {
    const snapshots = state.value.knowledge?.legalSnapshots || [];
    const nextSnapshots = updateLegalSnapshotState(snapshots, snapshotId, patch);
    state.value.knowledge.legalSnapshots = nextSnapshots;
    const snapshot = nextSnapshots.find((item) => item.id === snapshotId);
    for (const reviewItem of Object.values(state.value.reviews || {})) {
      if (reviewItem.config?.snapshot?.id === snapshot.id) {
        reviewItem.config.snapshot = { ...reviewItem.config.snapshot, status: snapshot.status };
      }
    }
    addAudit("编辑法律快照", snapshot.id, "已更新快照名称、覆盖范围、来源数、发布时间或状态");
    await persist();
    notify("法律快照已更新", "ok");
    return snapshot;
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
    const items = state.value.knowledge?.[type];
    if (!items?.[index]) return;
    items[index].selected = !items[index].selected;
    if (type === "rules") await saveConfig({ rules: selectedRules.value });
    if (type === "policies") await saveConfig({ policies: selectedPolicies.value });
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
    const item = createKnowledgeItem(type, payload);
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

  async function deleteKnowledge(type, files) {
    if (!["rules", "policies"].includes(type)) return;
    const targets = files.filter(Boolean);
    const items = state.value.knowledge?.[type] || [];
    state.value.knowledge[type] = removeKnowledgeItems(items, targets);
    for (const reviewItem of Object.values(state.value.reviews || {})) {
      const configFiles = reviewItem.config?.[type] || [];
      reviewItem.config[type] = configFiles.filter((file) => !targets.includes(file));
    }
    addAudit(type === "rules" ? "删除确定性规则" : "删除企业制度", targets.join(", "), `已移除 ${targets.length} 个知识文件，未删除本地原始文件`);
    await persist();
    notify(`已删除 ${targets.length} 个知识文件`, "ok");
  }

  async function saveModel(model) {
    const name = String(model.name || "").trim();
    if (!name) throw new Error("模型名称不能为空");
    if (!String(model.modelId || "").trim()) throw new Error("模型标识不能为空");
    if (!String(model.endpoint || "").trim()) throw new Error("API 地址不能为空");
    const models = state.value.capabilities?.models || [];
    const next = {
      ...model,
      name,
      modelId: String(model.modelId).trim(),
      endpoint: String(model.endpoint).trim(),
      version: String(model.version || "cfg-v1").trim(),
      status: model.status || "disabled",
      testStatus: model.testStatus || "untested"
    };
    state.value.capabilities.models = upsertModel(models, next);
    syncActiveReviewExecutionSnapshot();
    addAudit("保存模型配置", name, `${next.provider || "自定义服务"} · ${next.role || "未指定角色"}`);
    await persist();
    notify("模型配置已保存", "ok");
    return next;
  }

  async function deleteModel(name) {
    state.value.capabilities.models = removeModel(state.value.capabilities?.models || [], name);
    syncActiveReviewExecutionSnapshot();
    addAudit("删除模型配置", name, "已从模型角色列表移除");
    await persist();
    notify("模型配置已删除", "ok");
  }

  async function toggleModel(name) {
    const model = (state.value.capabilities?.models || []).find((item) => item.name === name);
    if (!model) return;
    model.status = model.status === "active" ? "disabled" : "active";
    syncActiveReviewExecutionSnapshot();
    addAudit(model.status === "active" ? "启用模型配置" : "停用模型配置", name, `当前状态：${model.status === "active" ? "启用" : "停用"}`);
    await persist();
    notify(model.status === "active" ? "模型已启用" : "模型已停用", "ok");
  }

  async function validateModel(name) {
    const model = (state.value.capabilities?.models || []).find((item) => item.name === name);
    if (!model) return false;
    const valid = Boolean(String(model.modelId || "").trim() && String(model.endpoint || "").trim());
    model.testStatus = valid ? "passed" : "failed";
    model.lastTestedAt = new Date().toISOString();
    addAudit("校验模型配置", name, valid ? "本地字段校验通过，未发起外部网络请求" : "本地字段校验失败，请补充模型标识和 API 地址");
    await persist();
    notify(valid ? "模型配置校验通过" : "模型配置校验失败，请检查必填字段", valid ? "ok" : "warn");
    return valid;
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

  async function runValidator(formats = ["DOCX", "PDF", "XLSX", "JSON"]) {
    if (!review.value) return null;
    isBusy.value = true;
    try {
      validatorResult.value = await electronApi.validateExport({ review: review.value, formats });
      return validatorResult.value;
    } finally {
      isBusy.value = false;
    }
  }

  async function runExport(formats) {
    if (!review.value) return null;
    isBusy.value = true;
    try {
      const result = await electronApi.exportReview({ review: review.value, formats });
      if (result.state) state.value = result.state;
      validatorResult.value = result.validation;
      if (result.records?.length) notify(`已生成 ${result.records.length} 个导出文件`, "ok");
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
    activeProject, review, risks, activeRisk, pendingRiskCount, selectedRules, selectedPolicies, reviewExecution,
    bootstrap, persist, notify, selectRisk, clearRisk, syncActiveReviewExecution, setPage, setZoom, applyRiskAction, importContract, runReview, importKnowledgeFiles, importLegalSnapshot, verifyLegalRealtime,
    saveConfig, updateLegalSnapshot, updateEnterpriseMemory, toggleKnowledge, addKnowledge, updateKnowledge, deleteKnowledge, saveModel, deleteModel,
    saveSelectionAnnotation, reviewSelection,
    toggleModel, validateModel, toggleSkill, updateSettings, runValidator, runExport, resetSample
  };
});
