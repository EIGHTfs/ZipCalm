<script setup>
// 轻量输入/确认对话框（M8）：重命名、新建文件夹、删除确认共用
//
// 为什么不用 window.prompt/confirm：它们在移动端 WebView 里样式不可控、也可能被浏览器拦截；
// 自写一个 20 行的即可，且能统一交给 Esc/Enter 处理（键盘可驱动是 M8 验收项）。

import { nextTick, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** prompt（要输入）| confirm（只要确认） */
  mode: { type: String, default: 'prompt' },
  title: { type: String, default: '' },
  label: { type: String, default: '' },
  /** 初始值（prompt 模式） */
  value: { type: String, default: '' },
  /** 危险操作（删除）：确认按钮标红 */
  danger: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['confirm', 'cancel']);

const draft = ref(props.value);
const inputRef = ref(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    draft.value = props.value;
    await nextTick();
    if (props.mode === 'prompt' && inputRef.value) {
      inputRef.value.focus();
      inputRef.value.select?.();
    }
  },
);

function onConfirm() {
  emit('confirm', props.mode === 'prompt' ? draft.value.trim() : true);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-backdrop" data-testid="prompt-dialog" @click.self="emit('cancel')">
      <section class="dialog" role="dialog" aria-modal="true" :aria-label="title" @keydown.esc.stop="emit('cancel')">
        <h3 class="dialog__title">{{ title }}</h3>
        <label v-if="mode === 'prompt'" class="dialog__field">
          <span>{{ label }}</span>
          <input
            ref="inputRef"
            v-model="draft"
            type="text"
            data-testid="prompt-input"
            @keyup.enter="onConfirm"
          />
        </label>
        <p v-else class="dialog__text">{{ label }}</p>

        <footer class="dialog__footer">
          <button type="button" data-testid="prompt-cancel" :disabled="busy" @click="emit('cancel')">取消</button>
          <button
            type="button"
            class="dialog__primary"
            :class="{ 'dialog__primary--danger': danger }"
            data-testid="prompt-confirm"
            :disabled="busy || (mode === 'prompt' && draft.trim().length === 0)"
            @click="onConfirm"
          >
            {{ busy ? '处理中…' : '确定' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
