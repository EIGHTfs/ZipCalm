<script setup>
// 解压对话框（M2）
//
// 契约（docs/M0/插件契约.md §3.4.1 + API 规范 §3.3）：
// - 目标目录可指定（不填则服务端生成"与压缩包同级的同名目录"）；
// - 「解压后删除压缩包」与压缩侧的「删除原文件」对称：**先校验 → 再删**，
//   且受 `delete.mode` 约束（默认 log-only 只记日志不真删）。

import { ref, watch } from 'vue';

import { api } from '../../api/client.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  archivePath: { type: String, default: '' },
  /** 当前存储根（docs/16） */
  rootId: { type: String, default: 'default' },
});
const emit = defineEmits(['close', 'submitted']);

const targetDir = ref('');
const deleteArchive = ref(false);
const submitting = ref(false);
const errorText = ref('');
const preflightInfo = ref(null);

watch(
  () => props.open,
  async (open) => {
    preflightInfo.value = null;
    errorText.value = '';
    if (!open) return;
    try {
      const preflight = await api.post('/extract/preflight', { path: props.archivePath, rootId: props.rootId });
      preflightInfo.value = preflight;
      if (preflight && preflight.targetDir) targetDir.value = preflight.targetDir;
    } catch (error) {
      errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
    }
  },
);

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const created = await api.post('/extract/tasks', {
      rootId: props.rootId,
      path: props.archivePath,
      targetDir: targetDir.value || undefined,
      options: { deleteArchiveAfterExtract: deleteArchive.value },
    });
    emit('submitted', created.task.id);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop" data-testid="extract-dialog" @click.self="emit('close')">
    <section class="drawer" role="dialog" aria-label="解压设置">
      <header class="drawer__header">
        <h3>解压</h3>
        <button type="button" class="drawer__close" data-testid="extract-close" @click="emit('close')">关闭</button>
      </header>

      <div class="drawer__body">
        <p class="card__desc">压缩包：<code>{{ archivePath }}</code></p>
        <p v-if="preflightInfo" class="card__desc">
          <!-- 格式由服务端按扩展名识别（复合扩展名取最长匹配），这里只做展示 -->
          识别格式：<span class="badge" data-testid="extract-format">{{ preflightInfo.formatName || preflightInfo.format || '未知' }}</span>
          · 内含 {{ preflightInfo.entries }} 个条目，解压后约 {{ preflightInfo.totalBytes }} 字节
        </p>

        <label class="field__label" for="extract-target">目标目录</label>
        <input id="extract-target" v-model="targetDir" type="text" data-testid="extract-target" placeholder="/目录名" />

        <label class="field__option">
          <input v-model="deleteArchive" type="checkbox" data-testid="delete-archive" />
          <span>解压后删除压缩包（先校验通过，再按 delete.mode 处理）</span>
        </label>

        <p v-if="errorText" class="login-form__error" data-testid="extract-error" role="alert">{{ errorText }}</p>
      </div>

      <footer class="drawer__footer">
        <button type="button" class="login-form__submit" :disabled="submitting" data-testid="extract-submit" @click="submit">
          {{ submitting ? '提交中…' : '开始解压' }}
        </button>
      </footer>
    </section>
  </div>
</template>
