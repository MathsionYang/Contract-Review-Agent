<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  Bot, Check, ChevronLeft, ChevronRight, ClipboardCheck, Clock3, FileCog, FileDown, Flag, Highlighter, ListChecks, LoaderCircle, Maximize2, MessageSquare, Minus, Plus, RotateCcw, ScanSearch, Search, Send, Settings2, SquarePen, Trash2, UserRound, X
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { riskCategories, riskLevels } from "../data/sampleData";
import { buildReviewPipeline, pipelineOverallLabel, pipelineStatusLabel } from "../services/reviewPipeline.mjs";
import ReviewChecklist from "./ReviewChecklist.vue";
import { locationLabel, locationPage, quoteRange } from "../services/checklistReview.mjs";

const emit = defineEmits(["configure", "export"]);
const store = useReviewStore();
const riskFilter = ref("all");
const resultTab = ref("risks");
const checklistEvidence = ref(null);
const searchQuery = ref("");
const documentTextElement = ref(null);
const selectionMenu = ref(null);
const lastSelection = ref(null);
const executionPanelOpen = ref(false);
const chatInput = ref("");
const memoryEdits = reactive({});
const selectionReviewForm = reactive({ reviewType: "legal_risk", topic: "general", contextScope: "selected_clause" });

const reviewTypeOptions = [
  { value: "legal_risk", label: "法律风险" },
  { value: "reasonableness", label: "条款合理性" },
  { value: "template_compare", label: "模板对比" },
  { value: "suggestion", label: "修改建议" },
  { value: "explanation", label: "条款解释" },
  { value: "special", label: "专项审核" }
];
const reviewTopicOptions = [
  { value: "general", label: "通用条款" },
  { value: "payment", label: "付款" },
  { value: "breach", label: "违约责任" },
  { value: "liability", label: "责任限制" },
  { value: "ip", label: "知识产权" },
  { value: "confidentiality", label: "保密" },
  { value: "data", label: "数据保护" },
  { value: "termination", label: "解除终止" },
  { value: "dispute", label: "争议解决" }
];
const contextScopeOptions = [
  { value: "selected_clause", label: "选区所在条款" },
  { value: "adjacent_clauses", label: "所在条款及前后同级条款" },
  { value: "linked_references", label: "条款及显式引用关系" }
];

const pageCount = computed(() => store.review?.document?.pageCount || store.review?.document?.pages?.length || 1);
const currentPage = computed(() => store.review?.document?.pages?.find((page) => Number(page.page) === store.selectedPage) || { page: store.selectedPage, text: "当前文档没有可展示的解析文本。" });
const currentRisk = computed(() => store.activeRisk);
const filteredRisks = computed(() => store.risks.filter((risk) => riskFilter.value === "all" || risk.risk_level === riskFilter.value));
const currentPageAnnotations = computed(() => (store.review?.annotations || []).filter((item) => Number(item.page) === Number(currentPage.value.page)));
const execution = computed(() => store.reviewExecution || { models: {}, skills: [] });
const executionModels = computed(() => [
  { key: "analysis", label: "语义分析" },
  { key: "extraction", label: "条款抽取" },
  { key: "embedding", label: "向量检索" },
  { key: "rerank", label: "结果重排" }
]);
const executionReady = computed(() => Boolean(execution.value.models?.analysis && execution.value.models?.extraction));
const task = computed(() => store.review?.task || {});
const taskStatus = computed(() => task.value.status || "queued");
const taskStepLabels = {
  parse: "解析合同",
  rules: "执行确定性规则",
  retrieve: "检索知识依据",
  model: "调用审查模型",
  validate: "校验审查结果",
  persist: "保存审查版本"
};
const taskStatusClass = computed(() => "task-" + taskStatus.value);
const taskStepLabel = computed(() => taskStepLabels[task.value.current_step] || "准备执行");
const taskProgress = computed(() => Math.min(Math.max(Number(task.value.progress) || 0, 0), 100));
const taskErrors = computed(() => Array.isArray(task.value.errors) ? task.value.errors : []);
const taskCanRetry = computed(() => ["partial", "failed"].includes(taskStatus.value) && !store.isBusy);
const pipelineRiskCount = computed(() => store.risks.length);
const taskErrorDetails = (error) => error.details || (error.check_ids || []).map((checkId) => ({ check_id: checkId,
  message: [...(store.review?.check_results || []), ...(store.review?.checklist_results || [])].find((check) => check.check_id === checkId)?.message || "需要补充输入或人工核验" }));
const reviewPipeline = computed(() => buildReviewPipeline(task.value, { riskCount: pipelineRiskCount.value }));
const pipelineCompletedCount = computed(() => reviewPipeline.value.filter((step) => step.status === "completed").length);
const pipelineActiveStep = computed(() => reviewPipeline.value.find((step) => ["running", "failed"].includes(step.status)) || null);
const pipelineOverallStatus = computed(() => pipelineOverallLabel(task.value));
const searchMatchCount = computed(() => {
  if (!searchQuery.value.trim()) return 0;
  return (currentPage.value.text.match(new RegExp(escapeRegExp(searchQuery.value.trim()), "gi")) || []).length;
});
const chatMessages = computed(() => store.chatMessages || []);
const chatModels = computed(() => store.activeAnalysisModels || []);
const chatSession = computed(() => store.activeChatSession);
const chatCandidates = computed(() => store.chatMemoryCandidates || []);
const chatModelName = computed({
  get: () => store.selectedChatModel || store.reviewExecution?.models?.analysis?.configId || store.reviewExecution?.models?.analysis?.name || chatModels.value[0]?.configId || chatModels.value[0]?.name || "",
  set: (value) => store.setChatModel(value)
});
const chatContextItems = computed(() => [
  { key: "includeKnowledge", label: "知识依据", enabled: store.chatContextPreferences.includeKnowledge },
  { key: "includeCurrentPage", label: "当前页", enabled: store.chatContextPreferences.includeCurrentPage },
  { key: "includeSelection", label: "当前选区", enabled: store.chatContextPreferences.includeSelection },
  { key: "includeCurrentRisk", label: "当前风险", enabled: store.chatContextPreferences.includeCurrentRisk },
  { key: "includeMemory", label: "企业记忆", enabled: store.chatContextPreferences.includeMemory }
]);

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

function renderText(value) {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function insertMarkers(text, markers) {
  const source = String(text || "");
  const candidates = markers
    .map((marker) => {
      const quote = String(marker.quote || "").trim();
      const range = quoteRange(source, quote);
      return range ? { ...marker, start: range[0], end: range[1] } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const accepted = [];
  for (const marker of candidates) {
    if (accepted.some((item) => marker.start < item.end && marker.end > item.start)) continue;
    accepted.push(marker);
  }
  accepted.sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const marker of accepted) {
    result += renderText(source.slice(cursor, marker.start));
    const attributes = [
      marker.riskId ? `data-risk="${escapeHtml(marker.riskId)}"` : "",
      marker.annotationId ? `data-annotation="${escapeHtml(marker.annotationId)}"` : ""
    ].filter(Boolean).join(" ");
    result += `<mark class="${marker.className}" ${attributes}>${renderText(source.slice(marker.start, marker.end))}</mark>`;
    cursor = marker.end;
  }
  return result + renderText(source.slice(cursor));
}

const renderedPageHtml = computed(() => {
  const text = currentPage.value.text || "";
  const riskMarkers = store.risks
    .filter((risk) => locationPage(risk.contract_location, store.review?.document) === Number(currentPage.value.page) && risk.contract_location?.quote)
    .map((risk) => ({
      quote: risk.contract_location.quote,
      className: `document-risk-hit${currentRisk.value?.risk_id === risk.risk_id ? " selected" : ""}`,
      riskId: risk.risk_id
    }));
  const annotationMarkers = currentPageAnnotations.value.map((annotation) => ({
    quote: annotation.text_snapshot,
    className: "document-manual-hit",
    annotationId: annotation.annotation_id
  }));
  const evidence = checklistEvidence.value;
  const evidenceMarkers = evidence && locationPage(evidence, store.review?.document) === Number(currentPage.value.page)
    ? [{ quote: evidence.quote, className: "document-checklist-hit" }] : [];
  const markers = [...evidenceMarkers, ...riskMarkers, ...annotationMarkers];
  if (searchQuery.value.trim()) {
    const term = searchQuery.value.trim();
    let offset = 0;
    while (offset < text.length) {
      const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase(), offset);
      if (index < 0) break;
      markers.push({ quote: text.slice(index, index + term.length), className: "document-search-hit" });
      offset = index + term.length;
    }
  }
  return insertMarkers(text, markers);
});

function selectRisk(risk) { checklistEvidence.value = null; store.selectRisk(risk.risk_id); }
async function locateChecklistEvidence(source) {
  const page = locationPage(source, store.review?.document);
  if (!page) { store.notify("当前证据尚无可导航的逻辑块或页码", "warn"); return; }
  store.clearRisk();
  checklistEvidence.value = source;
  store.setPage(page);
  await nextTick();
  documentTextElement.value?.querySelector(".document-checklist-hit")?.scrollIntoView({ block: "center", behavior: "smooth" });
}
watch(() => store.activeProject?.project_id, () => { checklistEvidence.value = null; });
watch(() => store.activeRiskId, async () => {
  await nextTick();
  documentTextElement.value?.querySelector(".document-risk-hit.selected")?.scrollIntoView({ block: "center", behavior: "smooth" });
});
function changePage(delta) { store.setPage(store.selectedPage + delta); }
function handleDocumentClick(event) {
  const riskId = event.target?.dataset?.risk;
  if (riskId) store.selectRisk(riskId);
}

function clearNativeSelection() {
  const selection = window.getSelection?.();
  if (selection?.removeAllRanges) selection.removeAllRanges();
}

function selectionOffset(container, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

function guessClauseNo(text, start) {
  const before = String(text || "").slice(0, Math.max(0, start));
  const matches = before.match(/(?:第[一二三四五六七八九十百]+条|\b\d+(?:\.\d+)+)/g);
  return matches?.at(-1) || "";
}

function selectionPayload() {
  if (!selectionMenu.value) return null;
  return {
    text: selectionMenu.value.text,
    fileVersionId: store.activeProject?.file_version_id,
    page: selectionMenu.value.page,
    clauseNo: selectionMenu.value.clauseNo,
    charRange: selectionMenu.value.charRange
  };
}

function selectionForChat() {
  if (lastSelection.value?.annotation_id) return { selectionRef: lastSelection.value.annotation_id };
  if (lastSelection.value) return { selection: { ...lastSelection.value, text: lastSelection.value.text_snapshot } };
  return {};
}

function closeSelectionMenu() {
  selectionMenu.value = null;
  clearNativeSelection();
}

function openSelectionReview() {
  if (!selectionMenu.value) return;
  selectionMenu.value.mode = "review";
}

async function markSelection() {
  const payload = selectionPayload();
  if (!payload) return;
  try {
    const annotation = await store.saveSelectionAnnotation(payload);
    lastSelection.value = annotation;
    closeSelectionMenu();
  } catch (error) {
    store.notify(error.message || "选区标记失败", "warn");
  }
}

async function submitSelectionReview() {
  const payload = selectionPayload();
  if (!payload) return;
  try {
    await store.reviewSelection({
      ...payload,
      reviewType: selectionReviewForm.reviewType,
      topic: selectionReviewForm.topic,
      contextScope: selectionScopeLabel.value
    });
    closeSelectionMenu();
  } catch (error) {
    store.notify(error.message || "局部审查提交失败", "warn");
  }
}

const selectionScopeLabel = computed(() => contextScopeOptions.find((item) => item.value === selectionReviewForm.contextScope)?.label || "选区所在条款");

function handleDocumentMouseUp(event) {
  const container = documentTextElement.value;
  const selection = window.getSelection?.();
  if (!container || !selection || selection.rangeCount === 0 || !selection.toString().trim()) return;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return;
  const text = selection.toString().trim();
  const rect = range.getBoundingClientRect();
  const start = selectionOffset(container, range.startContainer, range.startOffset);
  const end = selectionOffset(container, range.endContainer, range.endOffset);
  selectionMenu.value = {
    mode: "actions",
    text,
    page: currentPage.value.page,
    clauseNo: guessClauseNo(currentPage.value.text, start),
    charRange: [start, end],
    rect
  };
  lastSelection.value = {
    text_snapshot: text,
    file_version_id: store.activeProject?.file_version_id,
    page: currentPage.value.page,
    clause_no: guessClauseNo(currentPage.value.text, start),
    char_range: [start, end]
  };
}

function handleEscape(event) {
  if (event.key === "Escape") closeSelectionMenu();
}

const selectionMenuStyle = computed(() => {
  const rect = selectionMenu.value?.rect;
  if (!rect) return {};
  const menuWidth = selectionMenu.value?.mode === "review" ? 335 : 230;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - (selectionMenu.value?.mode === "review" ? 360 : 70)));
  return { left: `${left}px`, top: `${top}px` };
});

onMounted(() => window.addEventListener("keydown", handleEscape));
onBeforeUnmount(() => window.removeEventListener("keydown", handleEscape));
async function retryReview() {
  try {
    await store.runReview();
  } catch (_error) {
    // store 已将执行错误转换为顶部通知。
  }
}
async function handleRiskAction(action) {
  if (!currentRisk.value) return;
  await store.applyRiskAction(currentRisk.value.risk_id, action);
}
// 快捷操作也先打开当前风险气泡，避免只改状态却没有反馈详情上下文。
async function handleRiskCardAction(risk, action) {
  store.selectRisk(risk.risk_id);
  await store.applyRiskAction(risk.risk_id, action);
}
function toggleChatContext(key) {
  store.updateChatContextPreferences({ [key]: !store.chatContextPreferences[key] });
}
function memoryEdit(candidate) {
  if (!memoryEdits[candidate.candidate_id]) memoryEdits[candidate.candidate_id] = { content: candidate.content, scope: candidate.scope };
  return memoryEdits[candidate.candidate_id];
}
async function sendChat(prompt = "") {
  const content = String(prompt || chatInput.value || "").trim();
  if (!content || store.chatBusy) return;
  chatInput.value = "";
  try {
    await store.chatReview({ userInput: content, modelName: chatModelName.value, ...selectionForChat() });
  } catch (_error) {
    // store 已将错误转换为页面通知。
  }
}
async function retryChat(message) {
  try { await store.retryChat({ sessionId: chatSession.value?.chat_session_id, messageId: message.message_id, modelName: chatModelName.value }); } catch (_error) {}
}
async function confirmCandidate(candidate, resolution) {
  try {
    const result = await store.confirmMemoryCandidate({ candidateId: candidate.candidate_id, edited: memoryEdit(candidate), resolution });
    if (result?.errorCode === "MEMORY_CONFLICT") store.notify("请选择替换、合并或保留现有记忆", "warn");
  } catch (error) { store.notify(error.message || "记忆确认失败", "warn"); }
}
async function dismissCandidate(candidate) {
  try { await store.dismissMemoryCandidate(candidate.candidate_id); } catch (error) { store.notify(error.message || "记忆候选处理失败", "warn"); }
}
function citationLabel(citation) {
  return `${citation.file_name || "依据文件"} · ${citation.clause_no || "具体条款"}`;
}

watch(chatModels, (models) => {
  if (!models.some((m) => (m.configId || m.name) === store.selectedChatModel)) store.setChatModel(models[0]?.configId || models[0]?.name || "");
}, { immediate: true });
function riskBadge(risk) { return riskLevels[risk.risk_level] || riskLevels.info; }
function sourceFileName(source) { return source?.file_name || source?.fileName || source?.document_name || source?.documentName || source?.file || source?.title || "未命名依据"; }
function sourceClause(source) { return source?.clause_no || source?.clauseNo || source?.clause_title || source?.clauseTitle || source?.clause || source?.citation || "未绑定具体条款"; }
function sourceLevel(source) { return String(source?.source_level || "来源").toUpperCase(); }
function displaySize(bytes) {
  if (!bytes) return "-";
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
</script>

<template>
  <div class="workspace-page">
    <div class="workspace-grid">
      <section class="document-panel">
        <div class="document-context-stack">
          <div class="workspace-toolbar">
            <div class="workspace-document-title">
              <div class="file-type-mark">{{ store.activeProject?.file_name?.split(".").pop()?.toUpperCase() || "DOC" }}</div>
              <div><strong>{{ store.activeProject?.file_name || "未导入合同" }}</strong><span>{{ store.activeProject?.project_name || "等待导入" }} · {{ store.review?.document?.pageCount || 0 }} 页 · {{ displaySize(store.review?.document?.sizeBytes) }}</span></div>
            </div>
            <div class="workspace-toolbar-actions">
              <button class="icon-button" type="button" title="打开知识库配置" aria-label="打开知识库配置" @click="emit('configure')"><FileCog :size="16" /></button>
              <button class="icon-button" type="button" title="导出审查报告" aria-label="导出审查报告" @click="emit('export')"><FileDown :size="16" /></button>
              <div class="runtime-config-menu" :class="{ warning: !executionReady }">
                <button class="runtime-config-trigger" type="button" :aria-expanded="executionPanelOpen" aria-haspopup="dialog" @click="executionPanelOpen = !executionPanelOpen">
                  <Settings2 :size="14" />
                  <span>查看配置</span>
                  <strong>{{ executionReady ? "已就绪" : "需配置" }}</strong>
                </button>
                <div v-if="executionPanelOpen" class="runtime-config-popover" role="dialog" aria-label="本次审查执行配置" @click.stop>
                  <header class="runtime-config-popover-header">
                    <div><strong>本次审查执行配置</strong><small>本任务使用的版本化能力快照</small></div>
                    <button class="icon-button small" type="button" title="关闭执行配置" aria-label="关闭执行配置" @click="executionPanelOpen = false"><X :size="14" /></button>
                  </header>
                  <div class="runtime-model-list">
                    <span v-for="item in executionModels" :key="item.key" class="runtime-model-chip">
                      <small>{{ item.label }}</small>
                      <strong>{{ execution.models?.[item.key]?.name || "未配置" }}</strong>
                      <em v-if="execution.models?.[item.key]">{{ execution.models[item.key].version }}</em>
                    </span>
                  </div>
                  <div class="runtime-config-footer">
                    <div class="runtime-skill-count"><ListChecks :size="14" /><b>{{ execution.skills?.length || 0 }}</b><span>个 Skill</span></div>
                    <button class="text-action" type="button" @click="executionPanelOpen = false; emit('configure')"><Settings2 :size="13" />调整配置</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <section class="review-pipeline-card" :class="taskStatusClass" aria-live="polite">
            <header class="pipeline-header">
              <div>
                <div class="pipeline-title-row"><strong>审查任务流水线</strong><span class="pipeline-status" :class="`pipeline-status-${taskStatus}`">{{ pipelineOverallStatus }}</span></div>
                <p>{{ taskStatus === 'running' ? '当前结果为待核验候选' : '通用检查与专项检查' }}</p>
              </div>
              <div class="pipeline-header-actions"><div class="pipeline-summary"><strong>{{ pipelineRiskCount }}</strong><span>条风险</span><small>{{ pipelineCompletedCount }}/{{ reviewPipeline.length }} 阶段完成</small></div><button v-if="taskCanRetry" class="icon-button small" type="button" title="重试审查任务" aria-label="重试审查任务" @click="retryReview"><RotateCcw :size="14" /></button></div>
            </header>
            <div class="pipeline-overall-progress"><div class="task-progress-track"><span :style="{ width: taskProgress + '%' }"></span></div><strong>{{ taskProgress }}%</strong><span>{{ taskStepLabel }}</span></div>
            <div class="pipeline-steps">
              <article v-for="(step, index) in reviewPipeline" :key="step.key" class="pipeline-step" :class="`pipeline-step-${step.status}`">
                <div class="pipeline-step-head"><span class="pipeline-step-index">{{ index + 1 }}</span><span class="pipeline-step-status">{{ pipelineStatusLabel(step.status) }}</span></div>
                <strong>{{ step.label }}</strong>
                <small>{{ step.domain }}</small>
                <div class="pipeline-step-progress"><span :style="{ width: `${step.progress}%` }"></span></div>
                <em>{{ step.status === "running" ? `${step.progress}% · ${step.description}` : step.status === "failed" ? "存在错误，需处理后重试" : step.status === "completed" ? `${step.riskCount} 条风险已纳入结果` : step.status === "queued" ? "任务已创建" : "等待前置阶段" }}</em>
              </article>
            </div>
            <div v-if="taskErrors.length" class="task-error-list"><div v-for="error in taskErrors" :key="error.code + '-' + error.message" class="task-error-entry"><b>{{ error.code || "TASK_ERROR" }}</b> {{ error.message }}<details v-if="taskErrorDetails(error).length"><summary>{{ taskErrorDetails(error).length }} 项检查明细</summary><ul><li v-for="detail in taskErrorDetails(error)" :key="detail.check_id"><strong>{{ detail.check_id }}</strong>：{{ detail.message }}</li></ul></details><p v-if="error.suggestion">{{ error.suggestion }}</p></div></div>
            <div v-if="pipelineActiveStep && taskStatus === 'running'" class="pipeline-live-note"><LoaderCircle class="spin" :size="13" /><div>正在{{ pipelineActiveStep.label }}，当前已识别 {{ pipelineRiskCount }} 条候选风险<p v-if="store.reviewProgress?.latestRiskTitle" class="latest-risk-title">最新识别：{{ store.reviewProgress.latestRiskTitle }}</p></div></div>
            <div v-else-if="taskStatus === 'completed'" class="pipeline-live-note pipeline-live-note-success"><Check :size="13" />审查步骤已完成，可在右侧风险清单中逐条复核</div>
          </section>
        </div>
        <header class="pane-header">
          <div><h2>合同原文</h2><p>{{ store.review?.document?.documentType === "scanned_pdf" ? "扫描 PDF · OCR 不可用" : "解析文本层 · 可搜索" }}</p></div>
          <div class="document-tools">
            <div class="search-box"><Search :size="14" /><input v-model="searchQuery" type="search" placeholder="搜索本页" aria-label="搜索本页" /><small v-if="searchQuery">{{ searchMatchCount }}</small></div>
            <button class="icon-button small" type="button" title="缩小" aria-label="缩小" @click="store.setZoom(store.zoom - 0.1)"><Minus :size="14" /></button>
            <span class="zoom-value">{{ Math.round(store.zoom * 100) }}%</span>
            <button class="icon-button small" type="button" title="放大" aria-label="放大" @click="store.setZoom(store.zoom + 0.1)"><Plus :size="14" /></button>
            <button class="icon-button small" type="button" title="适应宽度" aria-label="适应宽度" @click="store.setZoom(1)"><Maximize2 :size="14" /></button>
          </div>
        </header>
        <div class="document-meta-strip">
          <span class="meta-pill">SHA-256 <b>{{ store.review?.document?.sha256?.slice(0, 12) || "-" }}...</b></span>
          <span class="meta-pill">文件版本 <b>{{ store.activeProject?.file_version_id || "-" }}</b></span>
          <span v-if="currentPageAnnotations.length" class="meta-pill manual">本页已标记 <b>{{ currentPageAnnotations.length }}</b></span>
          <span v-if="store.review?.document?.ocr?.status === 'unavailable'" class="meta-pill warning">OCR 未配置</span>
        </div>
        <div class="document-body">
          <div class="document-paper" :style="{ fontSize: `${14 * store.zoom}px` }" @click="handleDocumentClick">
            <div class="document-page-heading">{{ store.review?.document?.documentType === 'docx' ? '逻辑页' : '第' }} {{ currentPage.page }} / {{ pageCount }} {{ store.review?.document?.documentType === 'docx' ? '· 物理页码待确认' : '页' }}</div>
            <h3>{{ store.activeProject?.project_name || "合同原文" }}</h3>
            <p class="document-caption">{{ store.review?.document?.fileName || "等待导入合同文件" }}</p>
            <div ref="documentTextElement" class="document-text" v-html="renderedPageHtml" @mouseup="handleDocumentMouseUp" @touchend="handleDocumentMouseUp"></div>
            <div v-if="!store.review?.document?.pages?.length" class="document-empty">导入 DOCX 或 PDF 后显示真实解析文本</div>
          </div>
        </div>
        <footer class="document-footer">
          <button class="icon-button" type="button" title="上一页" aria-label="上一页" :disabled="store.selectedPage <= 1" @click="changePage(-1)"><ChevronLeft :size="17" /></button>
          <select v-model.number="store.selectedPage" class="page-select" aria-label="选择页码"><option v-for="page in pageCount" :key="page" :value="page">第 {{ page }} 页</option></select>
          <button class="icon-button" type="button" title="下一页" aria-label="下一页" :disabled="store.selectedPage >= pageCount" @click="changePage(1)"><ChevronRight :size="17" /></button>
        </footer>
      </section>

      <div class="review-side-column" :class="{ 'checklist-active': resultTab === 'checklist' }">
        <section class="chat-panel" aria-label="对话审核">
          <header class="chat-header">
            <div class="chat-title"><span class="chat-icon"><MessageSquare :size="16" /></span><div><h2>对话审核</h2><p>{{ chatSession ? `本地会话 · ${chatMessages.length} 条消息` : "输入自然语言，协同完成当前合同审核" }}</p></div></div>
            <label class="chat-model-select"><span>模型</span><select v-model="chatModelName" :disabled="store.chatBusy || !chatModels.length" aria-label="选择对话审核模型"><option value="" disabled>未配置可用模型</option><option v-for="model in chatModels" :key="model.configId || model.name" :value="model.configId || model.name">{{ model.name }} · {{ model.modelId }}{{ model.configId ? ' · ' + model.configId.slice(0, 8) : '' }}</option></select></label>
          </header>
          <div class="chat-context-bar">
            <span class="chat-context-label">本轮上下文</span>
            <span class="context-chip active fixed"><Check :size="12" />合同文件</span>
            <button v-for="item in chatContextItems" :key="item.key" class="context-chip" :class="{ active: item.enabled }" type="button" :aria-pressed="item.enabled" @click="toggleChatContext(item.key)"><Check v-if="item.enabled" :size="12" />{{ item.label }}</button>
            <select class="chat-scope-select" :value="store.chatContextPreferences.contextScope" aria-label="选择选区上下文范围" @change="store.updateChatContextPreferences({ contextScope: $event.target.value })"><option value="selected_clause">仅选区条款</option><option value="adjacent_clauses">前后同级条款</option><option value="current_chapter">当前页章节</option></select>
            <span v-if="lastSelection" class="chat-selection-note">{{ lastSelection.clause_no || "选区" }} · {{ lastSelection.text_snapshot?.slice(0, 18) }}{{ lastSelection.text_snapshot?.length > 18 ? "..." : "" }}</span>
          </div>
          <div class="chat-message-list" aria-live="polite">
            <div v-if="!chatMessages.length" class="chat-empty"><Bot :size="22" /><span>可以问我“审查当前选区”“检查付款责任”或“生成待核验风险”。</span></div>
            <article v-for="message in chatMessages" :key="message.message_id" class="chat-message" :class="`chat-message-${message.role} chat-message-${message.status || 'completed'}`">
              <span class="chat-avatar"><UserRound v-if="message.role === 'user'" :size="14" /><Bot v-else :size="15" /></span>
              <div class="chat-message-main">
                <div class="chat-message-meta"><strong>{{ message.role === "user" ? "你" : "审查助手" }}</strong><small>{{ message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "" }}</small><span v-if="message.model?.name" class="chat-model-badge">{{ message.model.name }}</span></div>
                <p>{{ message.content }}</p>
                <div v-if="message.status === 'failed' || message.status === 'cancelled'" class="chat-message-error"><span>{{ message.error_code || "CHAT_FAILED" }}</span><button class="text-action" type="button" @click="retryChat(message)"><RotateCcw :size="13" />重试</button></div>
                <div v-if="message.citations?.length" class="chat-citation-list"><span class="chat-result-label">依据</span><span v-for="citation in message.citations" :key="citation.citation_id" class="chat-citation">{{ citationLabel(citation) }}</span></div>
                <div v-if="message.risk_refs?.length" class="chat-result-card chat-risk-result"><div><strong>已生成待核验风险</strong><span>{{ message.risk_refs.length }} 条，已加入右侧风险清单</span></div><button class="text-action" type="button" @click="store.selectRisk(message.risk_refs[0])"><ScanSearch :size="13" />查看风险</button></div>
                <div v-if="message.review_action?.type === 'local_review'" class="chat-result-card"><div><strong>已触发局部审查</strong><span>{{ message.review_action.topic || "通用条款" }} · 结果需人工核验</span></div><button class="text-action" type="button" @click="message.risk_refs?.[0] && store.selectRisk(message.risk_refs[0])"><ScanSearch :size="13" />定位结果</button></div>
              </div>
            </article>
            <div v-if="store.chatBusy && store.chatStreamText" class="chat-streaming"><Bot :size="15" /><span>{{ store.chatStreamText }}</span></div>
          </div>
          <div v-if="chatCandidates.length" class="memory-candidate-list">
            <div class="memory-candidate-heading"><strong>待确认企业记忆</strong><span>不会自动写入正式记忆</span></div>
            <article v-for="candidate in chatCandidates" :key="candidate.candidate_id" class="memory-candidate-card">
              <textarea v-model="memoryEdit(candidate).content" rows="2" aria-label="编辑企业记忆候选内容"></textarea>
              <div class="memory-candidate-meta"><span>{{ candidate.scope }} · {{ candidate.memory_type }} · {{ Math.round(candidate.confidence * 100) }}%</span><span v-if="candidate.sensitivity_findings?.length" class="memory-sensitive">需要脱敏</span></div>
              <div v-if="candidate.conflicts?.length" class="memory-conflict"><strong>检测到冲突</strong><span>现有：{{ candidate.conflicts[0].content }}</span></div>
              <div class="memory-candidate-actions"><button class="text-action" type="button" @click="confirmCandidate(candidate)"><Check :size="13" />确认写入</button><button v-if="candidate.conflicts?.length" class="text-action" type="button" @click="confirmCandidate(candidate, 'replace')">替换</button><button v-if="candidate.conflicts?.length" class="text-action" type="button" @click="confirmCandidate(candidate, 'merge')">合并</button><button v-if="candidate.conflicts?.length" class="text-action" type="button" @click="confirmCandidate(candidate, 'keep_existing')">保留现有</button><button class="text-action danger-text" type="button" @click="dismissCandidate(candidate)"><X :size="13" />放弃</button></div>
            </article>
          </div>
          <div class="chat-composer">
            <textarea v-model="chatInput" rows="2" placeholder="输入自然语言审核请求..." aria-label="输入对话审核请求" :disabled="store.chatBusy || !chatModels.length" @keydown.enter.exact.prevent="sendChat()"></textarea>
            <div class="chat-composer-footer"><span>{{ chatModels.length ? "模型只会使用已勾选的上下文" : "请先在能力配置中启用 analysis 模型" }}</span><div><button v-if="store.chatBusy" class="icon-button small danger" type="button" title="停止对话审核" aria-label="停止对话审核" @click="store.cancelChat"><X :size="15" /></button><button class="icon-button chat-send-button" type="button" title="发送审核请求" aria-label="发送审核请求" :disabled="store.chatBusy || !chatInput.trim() || !chatModels.length" @click="sendChat()"><LoaderCircle v-if="store.chatBusy" class="spin" :size="16" /><Send v-else :size="16" /></button></div></div>
          </div>
        </section>

        <section class="risk-panel">
        <div class="review-result-tabs" role="tablist" aria-label="审查结果视图">
          <button id="risk-results-tab" role="tab" type="button" :aria-selected="resultTab === 'risks'" aria-controls="risk-results-panel" @click="resultTab = 'risks'"><Flag :size="14" />风险 {{ store.risks.length }}</button>
          <button id="checklist-results-tab" role="tab" type="button" :aria-selected="resultTab === 'checklist'" aria-controls="checklist-results-panel" @click="resultTab = 'checklist'"><ListChecks :size="14" />通用清单 {{ store.review?.checklist_results?.length || 0 }}</button>
        </div>
        <div v-show="resultTab === 'checklist'" id="checklist-results-panel" class="review-result-content" role="tabpanel" aria-labelledby="checklist-results-tab">
          <ReviewChecklist @locate="locateChecklistEvidence" @select-risk="selectRisk" />
        </div>
        <div v-show="resultTab === 'risks'" id="risk-results-panel" class="review-result-content" role="tabpanel" aria-labelledby="risk-results-tab">
        <header class="pane-header risk-pane-header">
          <div><h2>风险清单 <span class="count-label">{{ filteredRisks.length }}</span></h2><p>按等级筛选，点击风险定位到原文</p></div>
          <div class="risk-filter-select"><select v-model="riskFilter" aria-label="筛选风险等级"><option value="all">全部等级</option><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
        </header>
        <div class="risk-list">
          <article v-for="risk in filteredRisks" :key="risk.risk_id" class="risk-card" :class="{ selected: currentRisk?.risk_id === risk.risk_id }" @click="selectRisk(risk)">
            <div class="risk-card-head"><span class="badge" :class="riskBadge(risk).className"><span class="badge-dot"></span>{{ riskBadge(risk).label }}</span><span class="risk-category">{{ riskCategories[risk.risk_category] || "待分类" }}</span><span class="risk-id">{{ risk.risk_id }}</span></div>
            <h3>{{ risk.title }}</h3>
            <p class="risk-location">{{ locationLabel(risk.contract_location) }}</p>
            <div class="risk-flags"><span v-if="risk.evidence_status === 'verified'" class="flag flag-ok">证据已核验</span><span v-else class="flag flag-warn">需核验</span><span v-if="risk.human_status === 'pending_review'" class="flag flag-warn">待人工确认</span></div>
            <div class="risk-actions" @click.stop>
              <button class="icon-button small" type="button" title="接受风险" aria-label="接受风险" @click="handleRiskCardAction(risk, 'accepted')"><Check :size="14" /></button>
              <button class="icon-button small" type="button" title="标记误报" aria-label="标记误报" @click="handleRiskCardAction(risk, 'false_positive')"><X :size="14" /></button>
              <button class="icon-button small" type="button" title="标记为人工修改" aria-label="标记为人工修改" @click="handleRiskCardAction(risk, 'modified')"><SquarePen :size="14" /></button>
              <button class="icon-button small" type="button" title="延期处理" aria-label="延期处理" @click="handleRiskCardAction(risk, 'deferred')"><Clock3 :size="14" /></button>
            </div>
          </article>
          <div v-if="!filteredRisks.length" class="empty-state compact"><Flag :size="24" /><strong>暂时没有风险项</strong><span>导入合同并完成审查后，风险会显示在这里。</span></div>
        </div>
        </div>
        </section>

      <aside v-if="currentRisk" class="detail-panel risk-popover" role="dialog" aria-label="风险详情" @click.stop>
        <template v-if="currentRisk">
          <header class="detail-header">
            <button class="icon-button detail-close" type="button" title="关闭风险详情" aria-label="关闭风险详情" @click="store.clearRisk"><X :size="16" /></button>
            <div class="detail-kicker">{{ currentRisk.source_type === "manual_selection_review" ? "局部审查" : "风险详情" }} · {{ currentRisk.risk_id }}</div>
            <h2>{{ currentRisk.title }}</h2>
            <div class="detail-badges"><span class="badge" :class="riskBadge(currentRisk).className">{{ riskBadge(currentRisk).label }}风险</span><span class="badge badge-category">{{ riskCategories[currentRisk.risk_category] || "待分类" }}</span></div>
          </header>
          <div class="detail-actionbar">
            <button class="icon-button" type="button" title="接受风险" aria-label="接受风险" @click="handleRiskAction('accepted')"><Check :size="15" /></button>
            <button class="icon-button" type="button" title="标记误报" aria-label="标记误报" @click="handleRiskAction('false_positive')"><X :size="15" /></button>
            <button class="icon-button" type="button" title="人工修改" aria-label="人工修改" @click="handleRiskAction('modified')"><SquarePen :size="15" /></button>
            <button class="icon-button" type="button" title="延期处理" aria-label="延期处理" @click="handleRiskAction('deferred')"><Clock3 :size="15" /></button>
            <button class="icon-button danger" type="button" title="删除风险" aria-label="删除风险" @click="handleRiskAction('deleted')"><Trash2 :size="15" /></button>
          </div>
          <div class="detail-body">
            <section class="detail-section quote-section"><div class="section-title">合同定位</div><div class="quote-box"><span>{{ locationLabel(currentRisk.contract_location) }}</span>{{ currentRisk.contract_location?.quote || "无可验证的原文片段" }}</div><div class="detail-meta"><div><small>文件版本</small><b>{{ currentRisk.contract_location?.file_version_id || "-" }}</b></div><div><small>定位置信度</small><b>{{ Math.round((currentRisk.location_confidence || 0) * 100) }}%</b></div></div></section>
            <section class="detail-section"><div class="section-title">风险分析</div><p class="detail-copy">{{ currentRisk.analysis || "暂无风险分析" }}</p></section>
            <section class="detail-section proposal"><div class="section-title">修改建议</div><p class="detail-copy">{{ currentRisk.suggestion || "暂无修改建议" }}</p></section>
            <section class="detail-section"><div class="section-title">法律依据</div><div v-if="currentRisk.legal_basis?.length" class="source-list"><div v-for="source in currentRisk.legal_basis" :key="source.source_id" class="source-item"><span class="source-level">{{ sourceLevel(source) }}</span><div><strong>{{ sourceFileName(source) }}</strong><small class="source-clause"><span>具体条款</span>{{ sourceClause(source) }}</small><small class="source-excerpt"><span>条款原文</span>{{ source.excerpt || "未提供具体条款原文" }}</small></div></div></div><p v-else class="muted-text">暂无直接法律依据，导出时会保留此说明。</p></section>
            <section class="detail-section"><div class="section-title">企业制度与资料依据</div><div v-if="currentRisk.company_basis?.length" class="source-list"><div v-for="source in currentRisk.company_basis" :key="source.source_id" class="source-item"><span class="source-level">{{ sourceLevel(source) }}</span><div><strong>{{ sourceFileName(source) }}</strong><small class="source-clause"><span>具体条款</span>{{ sourceClause(source) }}</small><small class="source-excerpt"><span>条款原文</span>{{ source.excerpt || "未提供具体条款原文" }}</small></div></div></div><p v-else class="muted-text">暂无企业制度依据。</p></section>
          </div>
         </template>
         <div v-else class="empty-state"><FileDown :size="26" /><strong>选择一个风险</strong><span>从中间清单选择风险后查看定位、依据和处理建议。</span></div>
       </aside>
      </div>
    </div>

    <div v-if="selectionMenu" class="selection-popover" :class="{ 'selection-popover-form': selectionMenu.mode === 'review' }" :style="selectionMenuStyle" role="dialog" aria-label="选区操作" @mousedown.stop>
      <template v-if="selectionMenu.mode === 'actions'">
        <button class="icon-button small" type="button" title="高亮标记选区" aria-label="高亮标记选区" @click="markSelection"><Highlighter :size="15" /></button>
        <button class="icon-button small" type="button" title="审核选中内容" aria-label="审核选中内容" @click="openSelectionReview"><ScanSearch :size="15" /></button>
        <span class="selection-popover-hint">已选 {{ selectionMenu.text.length }} 字</span>
        <button class="icon-button small" type="button" title="关闭选区操作" aria-label="关闭选区操作" @click="closeSelectionMenu"><X :size="15" /></button>
      </template>
      <template v-else>
        <div class="selection-form-header"><div><strong>审核选中内容</strong><small>第 {{ selectionMenu.page }} 页 · {{ selectionMenu.clauseNo || "未标明条款" }}</small></div><button class="icon-button small" type="button" title="关闭局部审查" aria-label="关闭局部审查" @click="closeSelectionMenu"><X :size="15" /></button></div>
        <div class="selection-quote">{{ selectionMenu.text }}</div>
        <label class="selection-form-field"><span>审核类型</span><select v-model="selectionReviewForm.reviewType"><option v-for="option in reviewTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label class="selection-form-field"><span>专项方向</span><select v-model="selectionReviewForm.topic"><option v-for="option in reviewTopicOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label class="selection-form-field"><span>上下文范围</span><select v-model="selectionReviewForm.contextScope"><option v-for="option in contextScopeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <div class="selection-form-footer"><small>结果将以待核验风险加入当前清单</small><button class="icon-button" type="button" title="提交局部审查" aria-label="提交局部审查" @click="submitSelectionReview"><ClipboardCheck :size="16" /></button></div>
      </template>
    </div>
  </div>
</template>
