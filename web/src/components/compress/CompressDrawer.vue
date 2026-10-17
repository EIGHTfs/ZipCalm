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
// 黑名单开关（docs/11 §九、docs/04 §五）：默认开；关掉=本次压缩不做任何跳过
// 注意「重启后恢复默认」：全局层的开关不落盘（安全默认），这里只是本次任务级开关
const blacklistEnabled = ref(true);
const skipInfo = ref({ count: 0, patterns: [], layers: [] });
const previewToken = ref(0);
const submitting = ref(false);
const errorText = ref('');

const modeOptions = [COMPRESS_MODE.SINGLE, COMPRESS_MODE.BUNDLE];
const canSubmit = computed(() => props.sources.length > 0 && !submitting.value);

/**
 * 命中预览（POST /blacklist/preview）：告诉用户"这次会有几个文件被跳过"。
 * 为什么用 token：打开抽屉后用户可能连续改选择，慢请求返回晚就会覆盖新结果。
 * 预览失败不阻断压缩（它只是提示），所以这里静默降级为"没有跳过项"。
 */
async function runPreview() {
  const token = previewToken.value + 1;
  previewToken.value = token;
  if (!blacklistEnabled.value || props.sources.length === 0) {
    skipInfo.value = { count: 0, patterns: [], layers: [] };
    return;
  }
  try {
    const previewDoc = await api.post('/blacklist/preview', { paths: props.sources.map((source) => source.path), extraPatterns: [] });
    if (token !== previewToken.value) return; // 已有更新的请求，丢弃旧结果
    const skipped = (previewDoc && previewDoc.skipped) || [];
    skipInfo.value = {
      count: skipped.length,
      patterns: [...new Set(skipped.map((item) => item.pattern))],
      layers: [...new Set(skipped.map((item) => item.layer))],
    };
  } catch {
    if (token === previewToken.value) skipInfo.value = { count: 0, patterns: [], layers: [] };
  }
}

// 打开时拉一次格式列表（可用性由服务端判定，前端不猜）+ 跑一次命中预览
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    errorText.value = '';
    try {
      const formatsResponse = await api.get('/formats');
      formats.value = (formatsResponse && formatsResponse.formats) || [];
      const firstAvailable = formats.value.find((item) => item.available);
      if (firstAvailable) formatId.value = firstAvailable.id;
    } catch (error) {
      errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
    }
    await runPreview();
  },
);

// 选择变化/开关切换 → 重算提示（关掉黑名单时提示必须消失，否则会误导）
watch(() => props.sources, () => { void runPreview(); });
watch(blacklistEnabled, () => { void runPreview(); });

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const created = await api.post('/compress/tasks', {
      sources: props.sources.map((source) => source.path),
      mode: mode.value,
      format: formatId.value,
      options: {
        keepOriginal: keepOriginal.value,
        // 任务级开关：false = 本次不做任何黑名单跳过（三层全部不生效）
        blacklist: { enabled: blacklistEnabled.value },
      },
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

        <fieldset class="field">
          <legend>黑名单</legend>
          <label class="field__option">
            <input v-model="blacklistEnabled" type="checkbox" data-testid="blacklist-enabled" />
            <span>启用黑名单（跳过已压缩格式，如 jpg/mp4/zip/docx）</span>
          </label>
          <!-- 全局层的开关不落盘：这是安全默认，必须让用户知道，别以为是 bug -->
          <p class="field__hint">
            默认开启；<b>重启服务后恢复默认</b>（关掉全局保护是临时决定，不该被静默记住）。
          </p>
          <p
            v-if="blacklistEnabled && skipInfo.count > 0"
            class="field__hint"
            data-testid="blacklist-skip-hint"
            :title="`命中规则：${skipInfo.patterns.join('、')}（层：${skipInfo.layers.join('、')}）`"
          >
            <span class="badge">{{ skipInfo.count }} 个文件已跳过（已压缩格式）</span>
            这些文件不会进压缩包，也不会被「删除原文件」删掉。
          </p>
        </fieldset>

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
