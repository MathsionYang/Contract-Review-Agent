<script setup>
import { computed, reactive, ref } from "vue";
import {
  BookOpenCheck, Check, Eye, FileText, Filter, History, LockKeyhole, Pencil, Plus, Search, Settings2, Trash2, X
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { knowledgeData } from "../data/sampleData";
import Modal from "./Modal.vue";

const store = useReviewStore();
const activeTab = ref("rules");
const keyword = ref("");
const statusFilter = ref("all");
const formOpen = ref(false);
const deleteOpen = ref(false);
const editingFile = ref("");
const deleteTargets = ref([]);
const snapshotViewOpen = ref(false);
const snapshotEditOpen = ref(false);
const snapshotView = ref(null);
const editingSnapshotId = ref("");
const memoryFormOpen = ref(false);
const editingMemoryContent = ref("");
const tabs = [
  { id: "snapshots", label: "法律快照", icon: BookOpenCheck },
  { id: "rules", label: "确定性规则库", icon: Settings2 },
  { id: "policies", label: "企业制度", icon: FileText },
  { id: "memory", label: "企业记忆", icon: LockKeyhole },
  { id: "audit", label: "审计记录", icon: History }
];
const knowledgeForm = reactive({
  file: "",
  summary: "",
  type: "",
  version: "v1.0",
  priority: "high",
  status: "active",
  selected: false
});
const snapshotForm = reactive({
  name: "",
  status: "draft",
  coverage: "",
  sources: 0,
  publishedAt: ""
});
const memoryForm = reactive({
  content: "",
  scope: "",
  type: "",
  status: "正式",
  confidence: "0"
});

const sourceItems = computed(() => store.state.knowledge?.[activeTab.value] || []);
const tableItems = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return sourceItems.value.filter((item) => {
    const matchesKeyword = !query || JSON.stringify(item).toLowerCase().includes(query);
    const matchesStatus = statusFilter.value === "all" || item.status === statusFilter.value;
    return matchesKeyword && matchesStatus;
  });
});
const selectedCount = computed(() => sourceItems.value.filter((item) => item.selected).length);
const visibleSelectedCount = computed(() => tableItems.value.filter((item) => item.selected).length);
const allVisibleSelected = computed(() => Boolean(tableItems.value.length) && tableItems.value.every((item) => item.selected));
const isFileTab = computed(() => ["rules", "policies"].includes(activeTab.value));
const formTitle = computed(() => editingFile.value ? "编辑知识文件" : `新增${activeTab.value === "rules" ? "确定性规则" : "企业制度"}`);

function statusLabel(status) {
  return {
    published: "已发布",
    active: "启用",
    draft: "草稿",
    historical: "历史",
    formal: "正式",
    candidate: "候选",
    revoked: "已撤销"
  }[status] || status;
}

function statusClass(status) {
  return {
    published: "badge-success",
    active: "badge-success",
    draft: "badge-warning",
    historical: "badge-muted",
    formal: "badge-success",
    candidate: "badge-warning",
    revoked: "badge-danger"
  }[status] || "badge-muted";
}

function setActiveTab(tab) {
  activeTab.value = tab;
  statusFilter.value = "all";
  keyword.value = "";
}

async function selectSnapshot(snapshot) {
  if (snapshot.status !== "published") {
    store.notify("只有已发布法律快照可以绑定到审查", "warn");
    return;
  }
  await store.saveConfig({ snapshot: { id: snapshot.id, status: snapshot.status } });
}

async function toggle(type, item) {
  const index = (store.state.knowledge?.[type] || []).findIndex((source) => source.file === item.file);
  if (index >= 0) await store.toggleKnowledge(type, index);
}

async function toggleVisibleSelection() {
  const shouldSelect = !allVisibleSelected.value;
  for (const item of tableItems.value) {
    if (Boolean(item.selected) !== shouldSelect) await toggle(activeTab.value, item);
  }
}

function resetForm(item = null) {
  Object.assign(knowledgeForm, {
    file: item?.file || "",
    summary: item?.summary || "",
    type: item?.type || (activeTab.value === "rules" ? "自定义规则" : "企业制度"),
    version: item?.version || "v1.0",
    priority: item?.priority || "high",
    status: item?.status || (activeTab.value === "rules" ? "active" : "published"),
    selected: Boolean(item?.selected)
  });
}

function openCreate() {
  editingFile.value = "";
  resetForm();
  formOpen.value = true;
}

function openEdit(item) {
  editingFile.value = item.file;
  resetForm(item);
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
}

function openSnapshotView(snapshot) {
  snapshotView.value = snapshot;
  snapshotViewOpen.value = true;
}

function closeSnapshotView() {
  snapshotViewOpen.value = false;
  snapshotView.value = null;
}

function resetSnapshotForm(snapshot) {
  Object.assign(snapshotForm, {
    name: snapshot?.name || "",
    status: snapshot?.status || "draft",
    coverage: snapshot?.coverage || "",
    sources: Number(snapshot?.sources || 0),
    publishedAt: snapshot?.publishedAt || ""
  });
}

function openSnapshotEdit(snapshot) {
  editingSnapshotId.value = snapshot.id;
  resetSnapshotForm(snapshot);
  snapshotEditOpen.value = true;
}

function closeSnapshotEdit() {
  snapshotEditOpen.value = false;
  editingSnapshotId.value = "";
}

async function submitSnapshotForm() {
  try {
    await store.updateLegalSnapshot(editingSnapshotId.value, { ...snapshotForm });
    closeSnapshotEdit();
  } catch (error) {
    store.notify(error.message || "法律快照保存失败", "warn");
  }
}

function openMemoryEdit(item) {
  editingMemoryContent.value = item.content;
  Object.assign(memoryForm, {
    content: item.content || "",
    scope: item.scope || "",
    type: item.type || "",
    status: item.status || "正式",
    confidence: item.confidence || "0"
  });
  memoryFormOpen.value = true;
}

function closeMemoryForm() {
  memoryFormOpen.value = false;
  editingMemoryContent.value = "";
}

async function submitMemoryForm() {
  try {
    await store.updateEnterpriseMemory(editingMemoryContent.value, { ...memoryForm });
    closeMemoryForm();
  } catch (error) {
    store.notify(error.message || "企业记忆保存失败", "warn");
  }
}

async function submitForm() {
  try {
    if (editingFile.value) {
      await store.updateKnowledge(activeTab.value, editingFile.value, { ...knowledgeForm });
    } else {
      await store.addKnowledge(activeTab.value, { ...knowledgeForm });
    }
    closeForm();
  } catch (error) {
    store.notify(error.message || "知识文件保存失败", "warn");
  }
}

function askDelete(files) {
  deleteTargets.value = files.filter(Boolean);
  if (!deleteTargets.value.length) {
    store.notify("请先勾选要删除的知识文件", "warn");
    return;
  }
  deleteOpen.value = true;
}

function askDeleteOne(item) {
  askDelete([item.file]);
}

async function confirmDelete() {
  await store.deleteKnowledge(activeTab.value, deleteTargets.value);
  deleteTargets.value = [];
  deleteOpen.value = false;
}

function formatDate(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <p class="eyebrow dark">GOVERNANCE</p>
        <h2>知识库与规则</h2>
        <p>管理审查可引用的法律快照、确定性规则和企业制度版本。</p>
      </div>
      <div class="page-heading-actions">
        <div class="search-box page-search"><Search :size="15" /><input v-model="keyword" type="search" placeholder="搜索文件名或摘要" aria-label="搜索知识库" /></div>
        <label class="select-control"><Filter :size="14" /><span class="sr-only">状态筛选</span><select v-model="statusFilter" aria-label="筛选知识库状态"><option value="all">全部状态</option><option value="active">启用</option><option value="published">已发布</option><option value="draft">草稿</option><option value="historical">历史</option><option value="formal">正式</option><option value="candidate">候选</option><option value="revoked">已撤销</option></select></label>
      </div>
    </div>

    <div class="tabs-row">
      <button v-for="tab in tabs" :key="tab.id" class="tab-button" :class="{ active: activeTab === tab.id }" type="button" @click="setActiveTab(tab.id)"><component :is="tab.icon" :size="15" />{{ tab.label }}</button>
    </div>

    <section v-if="activeTab === 'snapshots'" class="panel">
      <div class="panel-header"><div><h2>法律快照版本</h2><p>审查只能绑定已发布快照，草稿与历史版本可查看但不能直接使用。</p></div><span class="badge badge-primary">当前：{{ store.review?.config?.snapshot?.id || "未绑定" }}</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>版本</th><th>状态</th><th>覆盖范围</th><th>来源数</th><th>发布时间</th><th>摘要</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="snapshot in (store.state.knowledge?.legalSnapshots || knowledgeData.legalSnapshots)" :key="snapshot.id"><td><strong>{{ snapshot.name }}</strong><span class="table-subtext mono">{{ snapshot.hash }}</span></td><td><span class="badge" :class="statusClass(snapshot.status)">{{ statusLabel(snapshot.status) }}</span></td><td>{{ snapshot.coverage }}</td><td>{{ snapshot.sources }}</td><td class="muted-text">{{ snapshot.publishedAt }}</td><td class="muted-text">已纳入版本化法律来源</td><td class="action-column"><div class="row-actions"><button class="icon-button small" type="button" title="查看法律快照" :aria-label="`查看 ${snapshot.name}`" @click="openSnapshotView(snapshot)"><Eye :size="14" /></button><button class="icon-button small" type="button" title="编辑法律快照" :aria-label="`编辑 ${snapshot.name}`" @click="openSnapshotEdit(snapshot)"><Pencil :size="14" /></button><button class="icon-button small" type="button" :title="snapshot.status === 'published' ? '绑定此快照' : '不可绑定草稿或历史版本'" :disabled="snapshot.status !== 'published'" @click="selectSnapshot(snapshot)"><Check :size="14" /></button></div></td></tr></tbody></table></div>
    </section>

    <section v-else-if="activeTab === 'rules' || activeTab === 'policies'" class="panel">
      <div class="panel-header">
        <div><h2>{{ activeTab === "rules" ? "确定性规则库" : "企业制度" }}</h2><p>按文件粒度选择本次审查引用内容，支持大量文件的检索、批量勾选和维护。</p></div>
        <div class="panel-header-actions">
          <div class="selection-summary">已选 <strong>{{ selectedCount }}</strong> / {{ sourceItems.length }}<span v-if="visibleSelectedCount !== selectedCount">（当前筛选 {{ visibleSelectedCount }}）</span></div>
          <button class="button small-button" type="button" @click="openCreate"><Plus :size="14" />新增文件</button>
          <button class="icon-button danger" type="button" title="批量删除已选文件" aria-label="批量删除已选文件" :disabled="selectedCount === 0" @click="askDelete(sourceItems.filter((item) => item.selected).map((item) => item.file))"><Trash2 :size="15" /></button>
        </div>
      </div>
      <div class="table-wrap"><table class="data-table file-table"><thead><tr><th class="check-column"><input type="checkbox" :checked="allVisibleSelected" :aria-label="allVisibleSelected ? '取消全选当前筛选' : '全选当前筛选'" @change="toggleVisibleSelection" /></th><th>文件名</th><th>文件摘要</th><th>类型 / 版本</th><th>状态</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="item in tableItems" :key="item.file"><td class="check-column"><input type="checkbox" :checked="item.selected" :aria-label="`选择 ${item.file}`" @change="toggle(activeTab, item)" /></td><td><div class="file-name"><FileText :size="16" /><strong>{{ item.file }}</strong></div></td><td class="summary-cell">{{ item.summary }}</td><td><span class="table-subtext">{{ item.type || "企业制度" }}</span><span class="table-subtext">{{ item.version || (item.priority === "blocker" ? "阻断级" : "高优先级") }}</span></td><td><span class="badge" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span></td><td class="action-column"><div class="row-actions"><button class="icon-button small" type="button" title="编辑文件摘要和元数据" :aria-label="`编辑 ${item.file}`" @click="openEdit(item)"><Pencil :size="14" /></button><button class="icon-button small danger" type="button" title="删除文件" :aria-label="`删除 ${item.file}`" @click="askDeleteOne(item)"><Trash2 :size="14" /></button></div></td></tr><tr v-if="!tableItems.length"><td colspan="6" class="empty-cell">没有匹配的知识文件</td></tr></tbody></table></div>
    </section>

    <section v-else-if="activeTab === 'memory'" class="panel">
      <div class="panel-header"><div><h2>企业记忆</h2><p>记忆仅作为审查提示，不能绕过规则、证据和人工复核门禁。</p></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>记忆内容</th><th>作用域</th><th>类型</th><th>状态</th><th>置信度</th><th class="action-column">操作</th></tr></thead><tbody><tr v-for="item in tableItems" :key="item.content"><td class="summary-cell">{{ item.content }}</td><td>{{ item.scope }}</td><td>{{ item.type }}</td><td><span class="badge" :class="statusClass(item.status === '正式' ? 'formal' : item.status === '候选' ? 'candidate' : 'revoked')">{{ item.status }}</span></td><td class="mono">{{ item.confidence }}</td><td class="action-column"><div class="row-actions"><button class="icon-button small" type="button" title="编辑企业记忆" :aria-label="`编辑企业记忆 ${item.content}`" @click="openMemoryEdit(item)"><Pencil :size="14" /></button></div></td></tr><tr v-if="!tableItems.length"><td colspan="6" class="empty-cell">没有匹配的企业记忆</td></tr></tbody></table></div>
    </section>

    <section v-else class="panel">
      <div class="panel-header"><div><h2>本地审计记录</h2><p>导入、人工处理、配置变更和导出门禁结果都在本地保留。</p></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>资源</th><th>结果</th><th>详情</th></tr></thead><tbody><tr v-for="record in store.state.auditRecords" :key="record.audit_id"><td class="mono muted-text">{{ formatDate(record.created_at) }}</td><td>{{ record.actor }}</td><td>{{ record.action }}</td><td class="mono">{{ record.resource }}</td><td><span class="badge" :class="record.result === '成功' ? 'badge-success' : record.result === 'EXPORT_BLOCKED' ? 'badge-danger' : 'badge-warning'">{{ record.result }}</span></td><td class="muted-text">{{ record.detail }}</td></tr><tr v-if="!store.state.auditRecords?.length"><td colspan="6" class="empty-cell">暂无审计记录</td></tr></tbody></table></div>
    </section>
  </div>

  <Modal :open="formOpen" :title="formTitle" :wide="true" @close="closeForm">
    <template #subtitle><p class="modal-subtitle">知识库列表只维护引用元数据，不会删除合同原始文件。</p></template>
    <div class="form-grid two-columns">
      <div class="form-field"><label>文件名 <span>*</span></label><input v-model="knowledgeForm.file" class="text-input" placeholder="例如：amount-arithmetic-rules@1.2" /></div>
      <div class="form-field"><label>{{ activeTab === "rules" ? "规则类型" : "制度类型" }}</label><input v-model="knowledgeForm.type" class="text-input" :placeholder="activeTab === 'rules' ? '金额计算 / 日期逻辑' : '采购制度 / 授权制度'" /></div>
      <div class="form-field field-span-2"><label>文件摘要 <span>*</span></label><textarea v-model="knowledgeForm.summary" class="text-area" rows="4" placeholder="说明文件覆盖的审查范围，便于列表检索和选择。"></textarea></div>
      <div class="form-field"><label>版本</label><input v-model="knowledgeForm.version" class="text-input" placeholder="v1.0" /></div>
      <div v-if="activeTab === 'rules'" class="form-field"><label>规则优先级</label><select v-model="knowledgeForm.priority" class="text-input"><option value="blocker">阻断级</option><option value="high">高优先级</option><option value="medium">中优先级</option></select></div>
      <div class="form-field"><label>状态</label><select v-model="knowledgeForm.status" class="text-input"><option v-if="activeTab === 'rules'" value="active">启用</option><option value="published">已发布</option><option value="draft">草稿</option></select></div>
      <label class="check-field"><input v-model="knowledgeForm.selected" type="checkbox" />默认纳入本次审查</label>
    </div>
    <template #footer><button class="button" type="button" @click="closeForm"><X :size="15" />取消</button><button class="button button-primary" type="button" @click="submitForm"><Check :size="15" />保存文件</button></template>
  </Modal>

  <Modal :open="snapshotViewOpen" title="查看法律快照" @close="closeSnapshotView">
    <div v-if="snapshotView" class="snapshot-detail">
      <div class="snapshot-detail-heading"><div><strong>{{ snapshotView.name }}</strong><span class="table-subtext mono">{{ snapshotView.id }}</span></div><span class="badge" :class="statusClass(snapshotView.status)">{{ statusLabel(snapshotView.status) }}</span></div>
      <div class="snapshot-detail-grid"><div><small>覆盖范围</small><strong>{{ snapshotView.coverage }}</strong></div><div><small>法律来源数</small><strong>{{ snapshotView.sources }}</strong></div><div><small>发布时间</small><strong>{{ snapshotView.publishedAt || "未发布" }}</strong></div><div><small>内容哈希</small><strong class="mono">{{ snapshotView.hash || "未记录" }}</strong></div></div>
      <div class="snapshot-detail-copy"><small>使用说明</small><p>该快照作为版本化法律来源参与合同审查；只有已发布状态可以绑定到审查配置。</p></div>
    </div>
    <template #footer><button class="button" type="button" @click="closeSnapshotView"><X :size="15" />关闭</button></template>
  </Modal>

  <Modal :open="snapshotEditOpen" title="编辑法律快照" :wide="true" @close="closeSnapshotEdit">
    <template #subtitle><p class="modal-subtitle">快照 ID 和内容哈希由版本系统维护，不可在此修改。</p></template>
    <div class="form-grid two-columns">
      <div class="form-field"><label>快照名称 <span>*</span></label><input v-model="snapshotForm.name" class="text-input" placeholder="例如：法律快照 CN-2026-09" /></div>
      <div class="form-field"><label>状态 <span>*</span></label><select v-model="snapshotForm.status" class="text-input"><option value="published">已发布</option><option value="draft">草稿</option><option value="historical">历史</option></select></div>
      <div class="form-field field-span-2"><label>覆盖范围 <span>*</span></label><textarea v-model="snapshotForm.coverage" class="text-area" rows="3" placeholder="例如：采购、服务、销售、租赁、软件开发"></textarea></div>
      <div class="form-field"><label>法律来源数 <span>*</span></label><input v-model.number="snapshotForm.sources" class="number-input" type="number" min="0" step="1" /></div>
      <div class="form-field"><label>发布时间</label><input v-model="snapshotForm.publishedAt" class="text-input" placeholder="例如：2026-09-05 18:30" /></div>
    </div>
    <template #footer><button class="button" type="button" @click="closeSnapshotEdit"><X :size="15" />取消</button><button class="button button-primary" type="button" @click="submitSnapshotForm"><Check :size="15" />保存快照</button></template>
  </Modal>

  <Modal :open="memoryFormOpen" title="编辑企业记忆" :wide="true" @close="closeMemoryForm">
    <template #subtitle><p class="modal-subtitle">企业记忆只作为审查提示，不会绕过规则、证据和人工复核门禁。</p></template>
    <div class="form-grid two-columns">
      <div class="form-field field-span-2"><label>记忆内容 <span>*</span></label><textarea v-model="memoryForm.content" class="text-area" rows="4" placeholder="输入可复用的企业审查经验"></textarea></div>
      <div class="form-field"><label>作用域 <span>*</span></label><input v-model="memoryForm.scope" class="text-input" placeholder="组织级 / 合同类型级" /></div>
      <div class="form-field"><label>类型 <span>*</span></label><input v-model="memoryForm.type" class="text-input" placeholder="企业偏好 / 历史经验" /></div>
      <div class="form-field"><label>状态 <span>*</span></label><select v-model="memoryForm.status" class="text-input"><option value="正式">正式</option><option value="候选">候选</option><option value="已撤销">已撤销</option></select></div>
      <div class="form-field"><label>置信度 <span>*</span></label><input v-model="memoryForm.confidence" class="number-input" type="number" min="0" max="1" step="0.01" /></div>
    </div>
    <template #footer><button class="button" type="button" @click="closeMemoryForm"><X :size="15" />取消</button><button class="button button-primary" type="button" @click="submitMemoryForm"><Check :size="15" />保存记忆</button></template>
  </Modal>

  <Modal :open="deleteOpen" title="删除知识文件" @close="deleteOpen = false">
    <p class="confirm-copy">将从知识库列表移除 <strong>{{ deleteTargets.length }}</strong> 个文件。此操作不会删除磁盘中的原始文件，但已从当前审查配置中解除引用。</p>
    <div class="confirm-list"><span v-for="file in deleteTargets" :key="file">{{ file }}</span></div>
    <template #footer><button class="button" type="button" @click="deleteOpen = false">取消</button><button class="button button-danger" type="button" @click="confirmDelete"><Trash2 :size="15" />确认删除</button></template>
  </Modal>
</template>
