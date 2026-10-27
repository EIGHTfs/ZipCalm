<script setup>
// 「修复乱码文件名」预览/确认对话框
//
// 为什么单独做一个而不是复用 PromptDialog：这里要展示**预览清单**（from → to + hex）与
// 四类计数（候选/不可还原/撞名/已改名），只靠"输入框 + 确认"表达不了。
// 交互上遵守项目对批量改名的纪律：**先预览、再确认、默认不改**（dryRun 默认 true）。

import { ref, watch } from 'vue';

import { api } from '../../api/client.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 要处理的目录（用户路径） */
  path: { type: String, default: '' },
  /** 存储根 id（多根模式下必须带上，否则会解析到默认根 → PATH_NOT_FOUND） */
  rootId: { type: String, default: '' },
});
const emit = defineEmits(['close', 'renamed']);

const loading = ref(false);
const busy = ref(false);
const errorText = ref('');
const report = ref(null);

/** 拉预览（dryRun: true —— 只出清单，不动文件） */
async function loadPreview() {
  loading.value = true;
  errorText.value = '';
  report.value = null;
  try {
    report.value = await api.post('/fs/repair-names', { path: props.path, rootId: props.rootId, dryRun: true });
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadPreview();
  },
);

/** 真正执行（显式 dryRun:false） */
async function confirmRepair() {
  busy.value = true;
  errorText.value = '';
  try {
    const result = await api.post('/fs/repair-names', { path: props.path, rootId: props.rootId, dryRun: false });
    report.value = result;
    if (result.renamed > 0) emit('renamed', result.renamed);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal-mask" data-testid="repair-names-dialog">
    <div class="modal-card">
      <header class="modal-card__head">
        <h3>修复乱码文件名</h3>
        <button class="modal-card__close" type="button" data-testid="repair-close" @click="emit('close')">关闭</button>
      </header>

      <p class="modal-card__hint">
        目录：<code>{{ path }}</code>
        <br />
        这些名字是老版引擎把 UTF-8 字节写成「U+FFFE + 私有区字符」造成的，可无损还原；带 <code>?</code> 的有损名救不回来，只列清单。
      </p>

      <p v-if="loading" class="modal-card__hint" data-testid="repair-loading">正在扫描…</p>
      <p v-if="errorText" class="modal-card__error" data-testid="repair-error">{{ errorText }}</p>

      <template v-if="report">
        <ul class="modal-card__stats" data-testid="repair-stats">
          <li>可还原：<b>{{ report.counts.candidates }}</b></li>
          <li>已改名：<b data-testid="repair-renamed">{{ report.renamed }}</b></li>
          <li>撞名跳过：<b>{{ report.counts.conflicts }}</b></li>
          <li>不可还原（有损）：<b>{{ report.counts.unrecoverable }}</b></li>
          <li>已扫描：{{ report.scanned }}</li>
        </ul>

        <ul v-if="report.candidates.length" class="modal-card__list" data-testid="repair-candidates">
          <li v-for="item in report.candidates.slice(0, 8)" :key="item.from">
            <span class="from">{{ item.from }}</span>
            <span class="arrow">→</span>
            <span class="to">{{ item.to }}</span>
          </li>
        </ul>
        <p v-else class="modal-card__hint">没有可还原的名字（或已经修复过了）。</p>

        <ul v-if="report.unrecoverable.length" class="modal-card__list">
          <li v-for="item in report.unrecoverable.slice(0, 5)" :key="item.path">
            <span class="from">{{ item.path }}</span>
            <span class="arrow">不可还原：{{ item.reason }}</span>
          </li>
        </ul>
      </template>

      <footer class="modal-card__foot">
        <button type="button" class="btn" data-testid="repair-cancel" @click="emit('close')">取消</button>
        <button
          type="button"
          class="btn btn--primary"
          data-testid="repair-confirm"
          :disabled="busy || loading || !report || report.counts.candidates === 0"
          @click="confirmRepair"
        >
          {{ busy ? '执行中…' : '确认修复' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 纯展示样式：遮罩 + 卡片；触屏下按钮保持 ≥40px 便于点击 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
  padding: 16px;
}
.modal-card {
  width: min(560px, 100%);
  max-height: 82vh;
  overflow: auto;
  background: var(--color-surface, #fff);
  border-radius: 12px;
  padding: 18px 20px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
}
.modal-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.modal-card__head h3 {
  margin: 0;
  font-size: 16px;
}
.modal-card__close {
  min-height: 40px;
  min-width: 64px;
  border: 1px solid var(--color-border, #d8dde6);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.modal-card__hint {
  margin: 10px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-muted, #5b6472);
}
.modal-card__error {
  margin: 10px 0;
  color: var(--color-danger, #d33);
  font-size: 13px;
}
.modal-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 0;
  margin: 10px 0;
  list-style: none;
  font-size: 13px;
}
.modal-card__list {
  margin: 8px 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  display: grid;
  gap: 6px;
}
.modal-card__list li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--color-surface-alt, #f5f7fa);
  word-break: break-all;
}
.modal-card__list .arrow {
  color: var(--color-text-muted, #5b6472);
}
.modal-card__list .to {
  color: var(--color-primary, #2f6fed);
  font-weight: 600;
}
.modal-card__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.modal-card__foot .btn {
  min-height: 40px;
  min-width: 88px;
  border-radius: 8px;
  border: 1px solid var(--color-border, #d8dde6);
  background: transparent;
  cursor: pointer;
}
.modal-card__foot .btn--primary {
  background: var(--color-primary, #2f6fed);
  border-color: var(--color-primary, #2f6fed);
  color: #fff;
}
.modal-card__foot .btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
