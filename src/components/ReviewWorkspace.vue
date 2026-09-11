<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  Check, ChevronLeft, ChevronRight, ClipboardCheck, Clock3, Cpu, FileCog, FileDown, Flag, Highlighter, ListChecks, Maximize2, Minus, Plus, ScanSearch, Search, Settings2, SquarePen, Trash2, X
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { riskCategories, riskLevels } from "../data/sampleData";

const emit = defineEmits(["configure", "export"]);
const store = useReviewStore();
const riskFilter = ref("all");
const searchQuery = ref("");
const documentTextElement = ref(null);
const selectionMenu = ref(null);
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
const searchMatchCount = computed(() => {
  if (!searchQuery.value.trim()) return 0;
  return (currentPage.value.text.match(new RegExp(escapeRegExp(searchQuery.value.trim()), "gi")) || []).length;
});

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
      const start = quote ? source.indexOf(quote) : -1;
      return start >= 0 ? { ...marker, start, end: start + quote.length } : null;
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
    .filter((risk) => Number(risk.contract_location?.page) === Number(currentPage.value.page) && risk.contract_location?.quote)
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
  const markers = [...riskMarkers, ...annotationMarkers];
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

function selectRisk(risk) { store.selectRisk(risk.risk_id); }
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
    await store.saveSelectionAnnotation(payload);
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
async function handleRiskAction(action) {
  if (!currentRisk.value) return;
  await store.applyRiskAction(currentRisk.value.risk_id, action);
}
// 快捷操作也先打开当前风险气泡，避免只改状态却没有反馈详情上下文。
async function handleRiskCardAction(risk, action) {
  store.selectRisk(risk.risk_id);
  await store.applyRiskAction(risk.risk_id, action);
}
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
    <div class="workspace-toolbar">
      <div class="workspace-document-title">
        <div class="file-type-mark">{{ store.activeProject?.file_name?.split(".").pop()?.toUpperCase() || "DOC" }}</div>
        <div><strong>{{ store.activeProject?.file_name || "未导入合同" }}</strong><span>{{ store.activeProject?.project_name || "等待导入" }} · {{ store.review?.document?.pageCount || 0 }} 页 · {{ displaySize(store.review?.document?.sizeBytes) }}</span></div>
      </div>
      <div class="workspace-toolbar-actions">
        <button class="icon-button" type="button" title="打开知识库配置" aria-label="打开知识库配置" @click="emit('configure')"><FileCog :size="16" /></button>
        <button class="icon-button" type="button" title="导出审查报告" aria-label="导出审查报告" @click="emit('export')"><FileDown :size="16" /></button>
      </div>
    </div>
    <div class="review-runtime-strip" :class="{ warning: !executionReady }">
      <div class="runtime-strip-title">
        <Cpu :size="16" />
        <div><strong>本次审查执行配置</strong><span>{{ executionReady ? "已绑定能力配置" : "缺少必要模型配置" }}</span></div>
      </div>
      <div class="runtime-model-list">
        <span v-for="item in executionModels" :key="item.key" class="runtime-model-chip">
          <small>{{ item.label }}</small>
          <strong>{{ execution.models?.[item.key]?.name || "未配置" }}</strong>
          <em v-if="execution.models?.[item.key]">{{ execution.models[item.key].version }}</em>
        </span>
      </div>
      <div class="runtime-skill-count"><ListChecks :size="15" /><b>{{ execution.skills?.length || 0 }}</b><span>个 Skill</span></div>
      <button class="icon-button small" type="button" title="查看并调整执行配置" aria-label="查看并调整执行配置" @click="emit('configure')"><Settings2 :size="14" /></button>
    </div>

    <div class="workspace-grid">
      <section class="document-panel">
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
            <div class="document-page-heading">第 {{ currentPage.page }} / {{ pageCount }} 页</div>
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

      <section class="risk-panel">
        <header class="pane-header risk-pane-header">
          <div><h2>风险清单 <span class="count-label">{{ filteredRisks.length }}</span></h2><p>按等级筛选，点击风险定位到原文</p></div>
          <div class="risk-filter-select"><select v-model="riskFilter" aria-label="筛选风险等级"><option value="all">全部等级</option><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
        </header>
        <div class="risk-list">
          <article v-for="risk in filteredRisks" :key="risk.risk_id" class="risk-card" :class="{ selected: currentRisk?.risk_id === risk.risk_id }" @click="selectRisk(risk)">
            <div class="risk-card-head"><span class="badge" :class="riskBadge(risk).className"><span class="badge-dot"></span>{{ riskBadge(risk).label }}</span><span class="risk-category">{{ riskCategories[risk.risk_category] || "待分类" }}</span><span class="risk-id">{{ risk.risk_id }}</span></div>
            <h3>{{ risk.title }}</h3>
            <p class="risk-location">第 {{ risk.contract_location?.page || "-" }} 页 · {{ risk.contract_location?.clause_no || "未标明条款" }}</p>
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
            <section class="detail-section quote-section"><div class="section-title">合同定位</div><div class="quote-box"><span>第 {{ currentRisk.contract_location?.page || "-" }} 页 · {{ currentRisk.contract_location?.clause_no || "未标明条款" }}</span>{{ currentRisk.contract_location?.quote || "未提供原文片段" }}</div><div class="detail-meta"><div><small>文件版本</small><b>{{ currentRisk.contract_location?.file_version_id || "-" }}</b></div><div><small>定位置信度</small><b>{{ Math.round((currentRisk.location_confidence || 0) * 100) }}%</b></div></div></section>
            <section class="detail-section"><div class="section-title">风险分析</div><p class="detail-copy">{{ currentRisk.analysis || "暂无风险分析" }}</p></section>
            <section class="detail-section proposal"><div class="section-title">修改建议</div><p class="detail-copy">{{ currentRisk.suggestion || "暂无修改建议" }}</p></section>
            <section class="detail-section"><div class="section-title">法律依据</div><div v-if="currentRisk.legal_basis?.length" class="source-list"><div v-for="source in currentRisk.legal_basis" :key="source.source_id" class="source-item"><span class="source-level">{{ sourceLevel(source) }}</span><div><strong>{{ sourceFileName(source) }}</strong><small class="source-clause"><span>具体条款</span>{{ sourceClause(source) }}</small><small class="source-excerpt"><span>条款原文</span>{{ source.excerpt || "未提供具体条款原文" }}</small></div></div></div><p v-else class="muted-text">暂无直接法律依据，导出时会保留此说明。</p></section>
            <section class="detail-section"><div class="section-title">企业制度与资料依据</div><div v-if="currentRisk.company_basis?.length" class="source-list"><div v-for="source in currentRisk.company_basis" :key="source.source_id" class="source-item"><span class="source-level">{{ sourceLevel(source) }}</span><div><strong>{{ sourceFileName(source) }}</strong><small class="source-clause"><span>具体条款</span>{{ sourceClause(source) }}</small><small class="source-excerpt"><span>条款原文</span>{{ source.excerpt || "未提供具体条款原文" }}</small></div></div></div><p v-else class="muted-text">暂无企业制度依据。</p></section>
          </div>
        </template>
        <div v-else class="empty-state"><FileDown :size="26" /><strong>选择一个风险</strong><span>从中间清单选择风险后查看定位、依据和处理建议。</span></div>
      </aside>
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
