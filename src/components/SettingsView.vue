<script setup>
import { reactive, ref, watch } from "vue";
import { Check, FolderOpen, HardDrive, LockKeyhole, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-vue-next";
import { useReviewStore } from "../stores/review";
import { defaultSettings } from "../data/sampleData";

const store = useReviewStore();
defineEmits(["new-review", "open-review", "configure", "export"]);
const settings = reactive({ ...defaultSettings });
const legalAllowlistText = ref("");
const exportOptions = ["DOCX", "PDF", "XLSX", "JSON"];

watch(
  () => store.state.settings,
  (value) => {
    Object.assign(settings, defaultSettings, value || {});
    legalAllowlistText.value = (value?.legalSourceAllowlist || []).join("\n");
  },
  { deep: true, immediate: true }
);

async function updateSetting(key, value) {
  await store.updateSettings({ [key]: value });
}

async function updateChatPermission(key, value) {
  const permissions = { ...(store.state.settings?.chatPermissions || defaultSettings.chatPermissions), [key]: value };
  settings.chatPermissions = permissions;
  await updateSetting("chatPermissions", permissions);
}

async function saveLegalAllowlist() {
  const allowlist = legalAllowlistText.value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  await updateSetting("legalSourceAllowlist", allowlist);
}

async function updateExportFormat(format, checked) {
  const formats = new Set(settings.defaultExportFormats || []);
  if (checked) formats.add(format);
  else formats.delete(format);
  if (!formats.size) {
    store.notify("至少保留一种默认导出格式", "warn");
    settings.defaultExportFormats = [...(store.state.settings?.defaultExportFormats || defaultSettings.defaultExportFormats)];
    return;
  }
  await updateSetting("defaultExportFormats", [...formats]);
}

async function resetSettings() {
  Object.assign(settings, defaultSettings);
  await store.updateSettings({ ...defaultSettings });
}

function openWorkspaceInfo() {
  store.notify("本地工作区由 Electron 主进程管理，合同原件不会上传到渲染层", "ok");
}

function clearLocalCache() {
  store.notify("当前版本没有独立缓存文件，清理操作不会删除合同原件或审查版本", "ok");
}
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <p class="eyebrow dark">LOCAL SETTINGS</p>
        <h2>系统设置</h2>
        <p>调整本地保存、导出门禁和界面偏好；修改会立即保存到当前桌面端工作区。</p>
      </div>
      <div class="page-heading-actions">
        <span class="badge badge-success"><Check :size="13" />配置自动保存</span>
        <button class="button" type="button" @click="resetSettings"><RotateCcw :size="15" />恢复默认</button>
      </div>
    </div>

    <div class="settings-grid">
      <section class="panel settings-card settings-card-wide">
        <div class="settings-card-heading"><div class="settings-card-icon"><HardDrive :size="19" /></div><div><h2>本地工作区</h2><p>合同原始文件、解析结果、审查版本和审计记录均保存在 Electron 用户数据目录。</p></div></div>
        <div class="setting-row"><span>存储模式</span><strong>本地文件系统</strong></div>
        <div class="setting-row"><span>当前项目</span><strong>{{ store.activeProject?.project_name || "未导入合同" }}</strong></div>
        <div class="setting-row"><span>原始文件</span><strong class="mono setting-value">{{ store.activeProject?.stored_path || "等待导入" }}</strong></div>
        <div class="settings-card-actions"><button class="button small-button" type="button" @click="openWorkspaceInfo"><FolderOpen :size="14" />查看存储说明</button><button class="icon-button" type="button" title="清理临时缓存" aria-label="清理临时缓存" @click="clearLocalCache"><Trash2 :size="15" /></button></div>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><Save :size="19" /></div><div><h2>自动保存</h2><p>控制配置和人工复核结果写入本地状态的频率。</p></div></div>
        <label class="toggle-row"><span><strong>启用自动保存</strong><small>配置变更和风险处理后自动保存</small></span><input v-model="settings.autoSave" type="checkbox" @change="updateSetting('autoSave', settings.autoSave)" /></label>
        <div class="setting-control-row"><label for="auto-save-interval">保存间隔（分钟）</label><input id="auto-save-interval" v-model.number="settings.autoSaveInterval" class="number-input" type="number" min="1" max="60" step="1" @change="updateSetting('autoSaveInterval', Math.min(60, Math.max(1, Number(settings.autoSaveInterval) || 5)))" /></div>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><FolderOpen :size="19" /></div><div><h2>导出策略</h2><p>导出前执行 Validator；阻断项存在时不会生成 completed 记录。</p></div></div>
        <label class="toggle-row"><span><strong>强制执行 Validator</strong><small>未通过校验时禁用导出按钮</small></span><input v-model="settings.forceValidator" type="checkbox" @change="updateSetting('forceValidator', settings.forceValidator)" /></label>
        <div class="setting-control-row setting-control-column"><span>默认导出格式</span><div class="format-check-list"><label v-for="format in exportOptions" :key="format" class="check-pill"><input :checked="settings.defaultExportFormats.includes(format)" type="checkbox" @change="updateExportFormat(format, $event.target.checked)" /><span>{{ format }}</span></label></div></div>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><ShieldCheck :size="19" /></div><div><h2>安全策略</h2><p>把不可验证的内容明确挡在导出门禁之外。</p></div></div>
        <label class="toggle-row"><span><strong>扫描 PDF 无 OCR 时阻断</strong><small>不伪造文本、页码或定位信息</small></span><input v-model="settings.blockScannedPdfWithoutOcr" type="checkbox" @change="updateSetting('blockScannedPdfWithoutOcr', settings.blockScannedPdfWithoutOcr)" /></label>
        <label class="toggle-row"><span><strong>检查敏感信息</strong><small>阻止疑似密钥和认证信息进入导出结果</small></span><input v-model="settings.checkSensitiveInfo" type="checkbox" @change="updateSetting('checkSensitiveInfo', settings.checkSensitiveInfo)" /></label>
        <div class="setting-control-row setting-control-column"><label for="legal-source-allowlist">实时法律来源白名单</label><textarea id="legal-source-allowlist" v-model="legalAllowlistText" class="text-area" rows="3" placeholder="每行填写一个 https:// 来源地址" @change="saveLegalAllowlist"></textarea><small class="setting-help">未配置白名单时不会发起实时法律来源请求。</small></div>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><LockKeyhole :size="19" /></div><div><h2>对话与记忆权限</h2><p>控制会话可见范围、企业记忆写入和 MCP / Skill 执行策略。</p></div></div>
        <div class="setting-control-row setting-control-column"><label for="session-access">会话访问</label><select id="session-access" class="settings-select" :value="settings.chatPermissions?.sessionAccess || 'local_user'" @change="updateChatPermission('sessionAccess', $event.target.value)"><option value="local_user">仅当前本地用户</option><option value="workspace">本地工作区用户</option></select></div>
        <div class="setting-control-row setting-control-column"><label for="memory-write">企业记忆写入</label><select id="memory-write" class="settings-select" :value="settings.chatPermissions?.memoryWrite || 'confirm_only'" @change="updateChatPermission('memoryWrite', $event.target.value)"><option value="confirm_only">必须人工确认</option><option value="deny">禁止写入</option></select></div>
        <div class="setting-control-row setting-control-column"><label for="tool-execution">MCP / Skill 执行</label><select id="tool-execution" class="settings-select" :value="settings.chatPermissions?.toolExecution || 'confirm'" @change="updateChatPermission('toolExecution', $event.target.value)"><option value="confirm">每次确认</option><option value="allow">允许已授权工具</option><option value="deny">禁止执行</option></select></div>
        <label class="toggle-row"><span><strong>外部模型允许敏感记忆</strong><small>关闭后外部模型只接收公开记忆</small></span><input :checked="settings.chatPermissions?.allowExternalModelSensitiveData === true" type="checkbox" @change="updateChatPermission('allowExternalModelSensitiveData', $event.target.checked)" /></label>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><LockKeyhole :size="19" /></div><div><h2>界面偏好</h2><p>调整审查工作区的密度和底部状态提示。</p></div></div>
        <label class="toggle-row"><span><strong>紧凑字号</strong><small>关闭后使用更易阅读的标准字号</small></span><input v-model="settings.compactMode" type="checkbox" @change="updateSetting('compactMode', settings.compactMode)" /></label>
        <label class="toggle-row"><span><strong>显示底部状态栏</strong><small>显示本地连接与技术栈状态</small></span><input v-model="settings.showStatusBar" type="checkbox" @change="updateSetting('showStatusBar', settings.showStatusBar)" /></label>
      </section>

      <section class="panel settings-card">
        <div class="settings-card-heading"><div class="settings-card-icon"><LockKeyhole :size="19" /></div><div><h2>安全边界</h2><p>渲染层不直接访问 Node.js、文件系统或子进程，所有本地能力通过白名单 API 调用。</p></div></div>
        <div class="setting-row"><span>Node 集成</span><strong>关闭</strong></div>
        <div class="setting-row"><span>上下文隔离</span><strong class="success-text">开启</strong></div>
        <div class="setting-row"><span>当前项目版本</span><strong class="mono setting-value">{{ store.activeProject?.file_version_id || "-" }}</strong></div>
      </section>
    </div>
  </div>
</template>
