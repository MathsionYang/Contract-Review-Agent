<script setup>
import { X } from "lucide-vue-next";
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, required: true },
  wide: { type: Boolean, default: false }
});
const emit = defineEmits(["close"]);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
      <section class="modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal-header"><div><h2>{{ title }}</h2><slot name="subtitle" /></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('close')"><X :size="17" /></button></header>
        <div class="modal-content"><slot /></div>
        <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
