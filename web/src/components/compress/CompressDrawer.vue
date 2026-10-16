<script setup>
// 压缩设置抽屉（M2）
//
// 契约（docs/08 第八节「压缩是核心操作」+ docs/04 两种模式互斥）：
// - 格式：M2 只有 zip（从 GET /formats 拉，available=false 的置灰）；M4 才做多格式；
// - 模式：单独压缩（single）/ 打包为一个（bundle）——**单选**，不是两个按钮；
// - 保留原文件：默认勾选（默认保留，删除必须显式请求，docs/06 §一）；
// - 提交后由父组件接管进度显示（本组件只负责收集参数 + 发请求）。

import { computed, ref, watch } from 'vue';

import { api } from '../../api/client.js';
import { COMPRESS_MODE, COMPRESS_MODE_HINTS, COMPRESS_MODE_LABELS } from '../../constants/index.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  sources: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'submitted']);

const formats = ref([]);
const formatId = ref('zip');
const mode = ref(COMPRESS_MODE.SINGLE);
const keepOriginal = ref(true);
const submitting = ref(false);
const errorText = ref('');

const modeOptions = [COMPRESS_MODE.SINGLE, COMPRESS_MODE.BUNDLE];
const canSubmit = computed(() => props.sources.length > 0 && !submitting.value);

// 打开时拉一次格式列表（可用性由服务端判定，前端不猜）
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    errorText.value = '';
    try {
      const data = await api.get('/formats');
      formats.value = (data && data.formats) || [];
      const firstAvailable = formats.value.find((item) => item.available);
      if (firstAvailable) formatId.value = firstAvailable.id;
    } catch (error) {
      errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
    }
  },
);

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const data = await api.post('/compress/tasks', {
      sources: props.sources.map((source) => source.path),
      mode: mode.value,
      format: formatId.value,
      options: { keepOriginal: keepOriginal.value },
    });
    emit('submitted', data.task.id);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop" data-testid="compress-drawer" @click.self="emit('close')">
    <section class="drawer" role="dialog" aria-label="压缩设置">
      <header class="drawer__header">
        <h3>压缩设置</h3>
        <button type="button" class="drawer__close" data-testid="compress-close" @click="emit('close')">关闭</button>
      </header>

      <div class="drawer__body">
        <p class="card__desc">已选 {{ sources.length }} 项</p>

        <fieldset class="field">
          <legend>格式</legend>
          <!-- 格式列表完全来自 GET /formats：新增一个格式包目录就会自动多一项，前端不需要改代码 -->
          <label
            v-for="item in formats"
            :key="item.id"
            class="field__option"
            :title="item.available ? `${item.mime}` : (item.unavailableReason || '不可用')"
          >
            <input
              v-model="formatId"
              type="radio"
              name="format"
              :value="item.id"
              :disabled="!item.available"
              :data-testid="`format-${item.id}`"
            />
            <span>{{ item.name }} <code>{{ item.ext }}</code></span>
            <span v-if="!item.available" class="badge badge--warn">{{ item.unavailableReason || '不可用' }}</span>
          </label>
        </fieldset>

        <fieldset class="field">
          <legend>压缩方式</legend>
          <label v-for="value in modeOptions" :key="value" class="field__option">
            <input v-model="mode" type="radio" name="mode" :value="value" />
            <span>{{ COMPRESS_MODE_LABELS[value] }}</span>
          </label>
          <p class="field__hint">{{ COMPRESS_MODE_HINTS[mode] }}</p>
        </fieldset>

        <label class="field__option">
          <input v-model="keepOriginal" type="checkbox" data-testid="keep-original" />
          <span>保留原文件（推荐；不勾选则在**校验通过后**按 delete.mode 处理）</span>
        </label>

        <p v-if="errorText" class="login-form__error" data-testid="compress-error" role="alert">{{ errorText }}</p>
      </div>

      <footer class="drawer__footer">
        <button type="button" class="login-form__submit" :disabled="!canSubmit" data-testid="compress-submit" @click="submit">
          {{ submitting ? '提交中…' : '开始压缩' }}
        </button>
      </footer>
    </section>
  </div>
</template>
