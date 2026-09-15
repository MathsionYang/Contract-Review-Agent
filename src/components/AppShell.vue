<script setup>
import { computed } from "vue";
import {
  FileCheck2, LayoutDashboard, LibraryBig, Settings2, ShieldCheck, Sparkles, RefreshCw, Plus, CircleUserRound
} from "lucide-vue-next";
import { useReviewStore } from "../stores/review";

const props = defineProps({ activeView: { type: String, required: true } });
const emit = defineEmits(["navigate", "new-review", "refresh"]);
const store = useReviewStore();

const navigation = [
  { id: "dashboard", label: "工作台", icon: LayoutDashboard, group: "工作区" },
  { id: "review", label: "审查工作区", icon: FileCheck2, group: "工作区", badge: true },
  { id: "knowledge", label: "知识库与规则", icon: LibraryBig, group: "治理" },
  { id: "capability", label: "能力配置", icon: Sparkles, group: "治理" },
  { id: "settings", label: "系统设置", icon: Settings2, group: "系统" }
];

const pageTitle = computed(() => navigation.find((item) => item.id === props.activeView)?.label || "工作台");
const groupedNavigation = computed(() => navigation.reduce((groups, item) => {
  (groups[item.group] ||= []).push(item);
  return groups;
}, {}));

function go(view) {
  emit("navigate", view);
}
</script>

<template>
  <div class="app-shell" :class="{ 'compact-mode': store.state.settings?.compactMode }">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><ShieldCheck :size="19" /></div>
        <div class="brand-copy">合同审查助手<small>Contract Review Workbench</small></div>
      </div>

      <nav class="side-nav" aria-label="主导航">
        <section v-for="(items, group) in groupedNavigation" :key="group" class="nav-group">
          <div class="nav-label">{{ group }}</div>
          <button
            v-for="item in items"
            :key="item.id"
            class="nav-item"
            :class="{ active: activeView === item.id }"
            type="button"
            @click="go(item.id)"
          >
            <component :is="item.icon" :size="16" :stroke-width="1.8" />
            <span>{{ item.label }}</span>
            <span v-if="item.badge && store.risks.length" class="nav-badge">{{ store.risks.length }}</span>
          </button>
        </section>
      </nav>

      <div class="side-user">
        <div class="avatar">法</div>
        <div class="side-user-copy"><strong>法务用户</strong><span>复核 / 规则维护</span></div>
        <CircleUserRound :size="16" />
      </div>
    </aside>

    <section class="main-area">
      <header class="topbar">
        <div>
          <h1>{{ pageTitle }}</h1>
          <div v-if="activeView === 'review' && store.activeProject" class="topbar-crumb">
            {{ store.activeProject.project_name }}
          </div>
        </div>
        <div class="topbar-spacer"></div>
        <button class="icon-button" type="button" title="刷新本地数据" aria-label="刷新本地数据" @click="emit('refresh')">
          <RefreshCw :size="16" />
        </button>
        <button v-if="activeView === 'dashboard'" class="button button-primary" type="button" @click="emit('new-review')">
          <Plus :size="16" />
          新建审查
        </button>
      </header>

      <main class="content-area">
        <slot />
      </main>

      <footer v-if="store.state.settings?.showStatusBar !== false" class="status-bar">
        <span class="status-item"><span class="status-dot"></span>本地工作区已连接</span>
        <span class="status-item">状态保存：自动</span>
        <span class="status-spacer"></span>
        <span class="status-item mono">Vue 3 · Electron · Local only</span>
      </footer>
    </section>

    <div class="toast-stack" aria-live="polite">
      <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="`toast-${toast.type}`">
        {{ toast.message }}
      </div>
    </div>
  </div>
</template>
