<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { Check, Cpu, FileDown, FileText, ListChecks, LoaderCircle, Save, UploadCloud } from "lucide-vue-next";
import AppShell from "./components/AppShell.vue";
import DashboardView from "./components/DashboardView.vue";
import ReviewWorkspace from "./components/ReviewWorkspace.vue";
import KnowledgeView from "./components/KnowledgeView.vue";
import CapabilityView from "./components/CapabilityView.vue";
import SettingsView from "./components/SettingsView.vue";
import Modal from "./components/Modal.vue";
import { useReviewStore } from "./stores/review";
import { contractTypes } from "./data/sampleData";
import { electronApi, hasElectronBridge } from "./services/electronApi";

const store = useReviewStore();
const initialView = new URLSearchParams(window.location.search).get("view");
const activeView = ref(["dashboard", "review", "knowledge", "capability", "settings"].includes(initialView) ? initialView : "dashboard");
const modal = ref(null);
const uploadForm = reactive({ projectName: "", contractType: "procurement", reviewMode: "standard", selection: null });
const configForm = reactive({ snapshotId: "CN-2026-09", reviewMode: "standard" });
const exportFormats = ref(["DOCX", "PDF", "JSON"]);
const isValidating = ref(false);

const pageComponent = computed(() => ({
  dashboard: DashboardView,
  review: ReviewWorkspace,
  knowledge: KnowledgeView,
  capability: CapabilityView,
  settings: SettingsView
}[activeView.value] || DashboardView));
const configRules = computed(() => store.state.knowledge?.rules || []);
const configPolicies = computed(() => store.state.knowledge?.policies || []);
const snapshots = computed(() => store.state.knowledge?.legalSnapshots || []);
const validator = computed(() => store.validatorResult);
const execution = computed(() => store.reviewExecution || { models: {}, skills: [] });
const executionModels = [
  { key: "analysis", label: "语义分析" },
  { key: "extraction", label: "条款抽取" },
  { key: "embedding", label: "向量检索" },
  { key: "rerank", label: "结果重排" }
];

onMounted(() => store.bootstrap());

function navigate(view) { activeView.value = view; }
function openUpload() {
  uploadForm.projectName = "";
  uploadForm.contractType = "procurement";
  uploadForm.reviewMode = "standard";
  uploadForm.selection = null;
  modal.value = "upload";
}
async function chooseContractFile() {
  const selection = await electronApi.selectContractFile();
  if (!selection) {
    store.notify(hasElectronBridge ? "未选择合同文件" : "请使用 Electron 桌面端选择本地合同文件", "warn");
    return;
  }
  uploadForm.selection = selection;
  if (!uploadForm.projectName) uploadForm.projectName = selection.fileName.replace(/\.[^.]+$/, "");
}
async function startImport() {
  if (!uploadForm.selection?.filePath) {
    store.notify("请先选择 DOCX 或 PDF 合同文件", "warn");
    return;
  }
  try {
    await store.importContract({
      filePath: uploadForm.selection.filePath,
      projectName: uploadForm.projectName || uploadForm.selection.fileName,
      contractType: uploadForm.contractType,
      reviewMode: uploadForm.reviewMode
    });
    modal.value = null;
    activeView.value = "review";
  } catch (_error) {
    // store 已经将可读错误通过通知反馈给用户。
  }
}
function openConfig() {
  configForm.snapshotId = store.review?.config?.snapshot?.id || "CN-2026-09";
  configForm.reviewMode = store.activeProject?.review_mode || "standard";
  modal.value = "config";
}
async function saveConfig() {
  const snapshot = snapshots.value.find((item) => item.id === configForm.snapshotId);
  if (!snapshot || snapshot.status !== "published") {
    store.notify("请选择已发布法律快照", "warn");
    return;
  }
  await store.saveConfig({ snapshot: { id: snapshot.id, status: snapshot.status }, reviewMode: configForm.reviewMode, rules: store.selectedRules, policies: store.selectedPolicies, execution: store.reviewExecution });
  modal.value = null;
}
async function toggleConfig(type, file) {
  const index = (store.state.knowledge?.[type] || []).findIndex((item) => item.file === file);
  if (index >= 0) await store.toggleKnowledge(type, index);
}
async function openExport() {
  if (!store.review) {
    store.notify("当前没有可导出的审查结果", "warn");
    return;
  }
  modal.value = "export";
  await validateExport();
}
async function validateExport() {
  isValidating.value = true;
  try { await store.runValidator(exportFormats.value); } finally { isValidating.value = false; }
}
async function startExport() {
  if (!exportFormats.value.length) {
    store.notify("至少选择一种导出格式", "warn");
    return;
  }
  const result = await store.runValidator(exportFormats.value);
  if (!result?.canExport) {
    store.notify(`导出已阻断：${result?.blockingCodes?.join("、") || "存在校验失败"}`, "warn");
    return;
  }
  const output = await store.runExport(exportFormats.value);
  if (output?.records?.length) modal.value = null;
}
function formatBytes(bytes) {
  if (!bytes) return "-";
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function statusClass(status) { return status === "published" || status === "active" ? "badge-success" : status === "draft" ? "badge-warning" : "badge-muted"; }
</script>

<template>
  <AppShell :active-view="activeView" @navigate="navigate" @new-review="openUpload" @refresh="store.bootstrap">
    <component :is="pageComponent" @new-review="openUpload" @open-review="() => navigate('review')" @configure="openConfig" @export="openExport" />
  </AppShell>

  <Modal :open="modal === 'upload'" title="新建合同审查" :wide="true" @close="modal = null">
    <template #subtitle><p class="modal-subtitle">导入本地合同后，创建独立项目和文件版本。</p></template>
    <div class="form-field"><label>项目名称 <span>*</span></label><input v-model="uploadForm.projectName" class="text-input" placeholder="例如：华东供应链设备采购合同" /></div>
    <div class="form-field"><label>合同类型 <span>*</span></label><div class="contract-type-grid"><button v-for="(label, key) in contractTypes" v-show="key !== 'other'" :key="key" class="type-card" :class="{ active: uploadForm.contractType === key }" type="button" @click="uploadForm.contractType = key"><strong>{{ label }}</strong><small>{{ key === "procurement" ? "采购 / 供货" : key === "supplier_service" ? "服务 / SLA" : key === "sales" ? "销售 / 客服" : key === "property_lease" ? "办公 / 仓库" : "定制 / 技术" }}</small></button></div></div>
    <div class="form-field"><label>合同文件 <span>*</span></label><button class="upload-dropzone" type="button" @click="chooseContractFile"><UploadCloud :size="28" /><strong>{{ uploadForm.selection?.fileName || "选择本地 DOCX 或 PDF 文件" }}</strong><small>支持 DOCX / 可搜索 PDF / 扫描 PDF，单文件不超过 50 MB</small></button><div v-if="uploadForm.selection" class="selected-file"><FileText :size="16" /><span>{{ uploadForm.selection.fileName }}</span><Check :size="15" /></div></div>
    <div class="form-field"><label>审查模式</label><div class="mode-grid"><button class="mode-card" :class="{ active: uploadForm.reviewMode === 'standard' }" type="button" @click="uploadForm.reviewMode = 'standard'"><strong>标准审查</strong><small>离线法律快照 + 企业知识库</small></button><button class="mode-card" :class="{ active: uploadForm.reviewMode === 'realtime' }" type="button" @click="uploadForm.reviewMode = 'realtime'"><strong>实时核查</strong><small>高风险项查询实时法律来源</small></button></div></div>
    <template #footer><button class="button" type="button" @click="modal = null">取消</button><button class="button button-primary" type="button" :disabled="store.isBusy" @click="startImport"><LoaderCircle v-if="store.isBusy" class="spin" :size="15" /><UploadCloud v-else :size="15" />开始审查</button></template>
  </Modal>

  <Modal :open="modal === 'config'" title="本次审查配置" :wide="true" @close="modal = null">
    <template #subtitle><p class="modal-subtitle">选择版本化法律来源、确定性规则库和企业制度。</p></template>
    <div class="config-overview"><div><small>合同类型</small><strong>{{ contractTypes[store.activeProject?.contract_type] || "未确认" }}</strong></div><div><small>审查模式</small><strong>{{ configForm.reviewMode === "realtime" ? "实时核查" : "标准审查" }}</strong></div><div><small>文件版本</small><strong class="mono">{{ store.activeProject?.file_version_id || "-" }}</strong></div></div>
    <div class="config-section execution-config-section">
      <div class="config-section-title"><Cpu :size="15" /><strong>本次审查执行配置</strong><span>审查工作区将使用当前启用版本</span></div>
      <div class="execution-config-grid">
        <div v-for="item in executionModels" :key="item.key" class="execution-config-item">
          <small>{{ item.label }}</small>
          <strong>{{ execution.models?.[item.key]?.name || "未配置" }}</strong>
          <span v-if="execution.models?.[item.key]" class="mono">{{ execution.models[item.key].version }}</span>
        </div>
      </div>
      <div class="execution-skills"><ListChecks :size="14" /><span>已启用 Skill</span><strong>{{ execution.skills?.length || 0 }}</strong><em v-for="skill in execution.skills || []" :key="`${skill.name}-${skill.version}`">{{ skill.name }} · {{ skill.version }}</em></div>
    </div>
    <div class="form-field"><label>法律快照</label><div class="snapshot-grid"><button v-for="snapshot in snapshots" :key="snapshot.id" class="mode-card snapshot-card" :class="{ active: configForm.snapshotId === snapshot.id }" type="button" :disabled="snapshot.status !== 'published'" @click="configForm.snapshotId = snapshot.id"><strong>{{ snapshot.name }}</strong><small>{{ snapshot.sources }} 部法规 · {{ snapshot.status === "published" ? "已发布" : snapshot.status === "draft" ? "校验中" : "历史归档" }}</small></button></div></div>
    <div class="config-section"><div class="config-section-title"><strong>确定性规则库</strong><span>勾选本次启用规则集</span></div><div class="config-table-wrap"><table class="config-table"><thead><tr><th>勾选</th><th>文件名</th><th>文件摘要</th><th>状态</th></tr></thead><tbody><tr v-for="item in configRules" :key="item.file"><td><input type="checkbox" :checked="item.selected" :aria-label="`选择规则 ${item.file}`" @change="toggleConfig('rules', item.file)" /></td><td><strong>{{ item.file }}</strong></td><td>{{ item.summary }}</td><td><span class="badge" :class="statusClass(item.status)">{{ item.status === "active" ? "启用" : "草稿" }}</span></td></tr></tbody></table></div></div>
    <div class="config-section"><div class="config-section-title"><strong>企业制度</strong><span>勾选本次引用制度</span></div><div class="config-table-wrap"><table class="config-table"><thead><tr><th>勾选</th><th>文件名</th><th>文件摘要</th><th>版本 / 状态</th></tr></thead><tbody><tr v-for="item in configPolicies" :key="item.file"><td><input type="checkbox" :checked="item.selected" :aria-label="`选择制度 ${item.file}`" @change="toggleConfig('policies', item.file)" /></td><td><strong>{{ item.file }}</strong></td><td>{{ item.summary }}</td><td><span class="badge" :class="statusClass(item.status)">{{ item.version }} · {{ item.status === "published" ? "已发布" : "草稿" }}</span></td></tr></tbody></table></div></div>
    <template #footer><button class="button" type="button" @click="modal = null">取消</button><button class="button button-primary" type="button" @click="saveConfig"><Save :size="15" />保存配置</button></template>
  </Modal>

  <Modal :open="modal === 'export'" title="导出审查报告" @close="modal = null">
    <template #subtitle><p class="modal-subtitle">导出前自动执行 Validator；存在阻断项时不会生成完成记录。</p></template>
    <div class="form-field"><label>导出格式</label><div class="format-grid"><label v-for="format in ['DOCX','PDF','XLSX','JSON']" :key="format" class="format-option"><input v-model="exportFormats" type="checkbox" :value="format" @change="validateExport" /><span><FileDown :size="15" />{{ format }}</span></label></div></div>
    <div class="validator-box" :class="{ passed: validator?.canExport, failed: validator && !validator.canExport }"><div class="validator-heading"><div><small>导出门禁</small><strong>{{ isValidating ? "校验中..." : validator?.canExport ? "校验通过，可导出" : "存在阻断项，暂不可导出" }}</strong></div><Check v-if="validator?.canExport" :size="20" /><LoaderCircle v-else-if="isValidating" class="spin" :size="20" /></div><div v-if="validator && !validator.canExport" class="blocking-codes"><span v-for="code in validator.blockingCodes" :key="code" class="code-chip">{{ code }}</span></div><div class="validator-items"><div v-for="item in validator?.items || []" :key="item.id" class="validator-item"><span :class="item.status === 'passed' ? 'pass-mark' : 'fail-mark'">{{ item.status === "passed" ? "✓" : "!" }}</span><span>{{ item.label }}</span><small>{{ item.message }}</small></div></div></div>
    <template #footer><button class="button" type="button" @click="modal = null">取消</button><button class="button button-primary" type="button" :disabled="!validator?.canExport || store.isBusy" @click="startExport"><LoaderCircle v-if="store.isBusy" class="spin" :size="15" /><FileDown v-else :size="15" />选择目录并导出</button></template>
  </Modal>
</template>
