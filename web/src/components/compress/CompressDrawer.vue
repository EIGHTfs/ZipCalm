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
import { useUiStore } from '../../stores/ui.js';
import { COMPRESS_MODE, COMPRESS_MODE_HINTS, COMPRESS_MODE_LABELS } from '../../constants/index.js';
import { formatBytes } from '../../utils/format.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  sources: { type: Array, default: () => [] },
  /** 当前存储根（docs/16）：黑名单预览与任务创建都必须带它 */
  rootId: { type: String, default: 'default' },
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
 * 预检（POST /compress/preflight）：一次请求同时拿到「黑名单跳过项」与「硬链接统计」。
 *
 * 为什么不用 /blacklist/preview：那个端点不含格式信息，而硬链接提示必须知道"当前格式保不保留
 * 硬链接"（zip 不保留、tar 系保留）。两处都调会为同一个目录多走一遍遍历，抽屉打开会明显变慢。
 *
 * 预检失败不阻断压缩（它只是提示）：静默降级成"没有提示"，真正的拦截仍在提交时由同一份预检给出。
 */
const ui = useUiStore();

const preflightInfo = ref(null);

async function runPreflight() {
  const token = previewToken.value + 1;
  previewToken.value = token;
  if (props.sources.length === 0) {
    preflightInfo.value = null;
    skipInfo.value = { count: 0, patterns: [], layers: [] };
    return;
  }
  try {
    const doc = await api.post('/compress/preflight', {
      sources: props.sources.map((source) => source.path),
      format: formatId.value,
      mode: mode.value,
      rootId: props.rootId,
      options: { blacklist: { enabled: blacklistEnabled.value } },
    });
    if (token !== previewToken.value) return; // 已有更新的请求，丢弃旧结果
    preflightInfo.value = doc || null;
    const skipped = (doc && doc.skipped) || [];
    skipInfo.value = {
      count: skipped.length,
      patterns: [...new Set(skipped.map((item) => item.pattern))],
      layers: [...new Set(skipped.map((item) => item.layer))],
    };
  } catch {
    if (token === previewToken.value) {
      preflightInfo.value = null;
      skipInfo.value = { count: 0, patterns: [], layers: [] };
    }
  }
}

/**
 * 硬链接提示：只在"真有硬链接"时出现，且**随格式变化**。
 * - 当前格式不保留硬链接（zip）：达到阈值才提示，说明会多存多少、换 TAR 能省多少
 * - 当前格式保留硬链接（tar 系）：给正向说明，避免"切了 tar 还提示 ZIP 会翻倍"的自相矛盾
 */
const hardlinkHint = computed(() => {
  const hardlinks = preflightInfo.value && preflightInfo.value.hardlinks;
  if (!hardlinks || !hardlinks.groups) return null;
  if (hardlinks.preservedByFormat) {
    return {
      tone: 'ok',
      groups: hardlinks.groups,
      files: hardlinks.files,
      savedText: hardlinks.duplicateBytes > 0 ? formatBytes(hardlinks.duplicateBytes) : null,
    };
  }
  if (!hardlinks.hint) return null;
  return {
    tone: 'info',
    groups: hardlinks.groups,
    files: hardlinks.files,
    estimatedText: formatBytes(hardlinks.estimatedBytes),
    tarEstimatedText: formatBytes(Math.max(0, hardlinks.logicalBytes - hardlinks.duplicateBytes)),
    savedText: formatBytes(hardlinks.duplicateBytes),
  };
});

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
    await runPreflight();
  },
);

// 选择变化/开关切换/换格式 → 重算提示（关掉黑名单时提示必须消失，否则会误导；
// 换格式时硬链接提示必须跟着变，否则会出现"选了 tar 还提示 ZIP 会翻倍"）
watch(() => props.sources, () => { void runPreflight(); });
watch(blacklistEnabled, () => { void runPreflight(); });
watch(formatId, () => { void runPreflight(); });

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const created = await api.post('/compress/tasks', {
      sources: props.sources.map((source) => source.path),
      rootId: props.rootId,
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
        <p class="card__desc" data-testid="compress-dest">
          已选 {{ sources.length }} 项 · 产物将保存到「{{ ui.currentRootLabel }}」的 {{ ui.currentDirLabel }}
        </p>

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

        <!--
          硬链接提示：纯信息条，不阻断操作（用户可以忽略继续压缩）。
          位置放在格式选择之后：用户刚换完格式，这里正好回答"我这个格式会多存多少"。
        -->
        <p
          v-if="hardlinkHint"
          class="drawer__hardlink-hint"
          :class="`drawer__hardlink-hint--${hardlinkHint.tone}`"
          data-testid="hardlink-hint"
        >
          <template v-if="hardlinkHint.tone === 'ok'">
            已检测到 <b>{{ hardlinkHint.groups }}</b> 组硬链接（共 <b>{{ hardlinkHint.files }}</b> 个文件）：当前格式会保留硬链接，同一份数据只存一份<template v-if="hardlinkHint.savedText">，比各存一份省 <b>{{ hardlinkHint.savedText }}</b></template>。
          </template>
          <template v-else>
            检测到 <b>{{ hardlinkHint.groups }}</b> 组硬链接（共 <b>{{ hardlinkHint.files }}</b> 个文件）：<b>{{ formatId.toUpperCase() }}</b> 不支持硬链接，同一份数据会各存一份，预计产出 <b>{{ hardlinkHint.estimatedText }}</b>；改用 TAR 只存一份，约 <b>{{ hardlinkHint.tarEstimatedText }}</b>（省 <b>{{ hardlinkHint.savedText }}</b>）。
          </template>
        </p>

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
          <span>保留原文件（推荐；不勾选则在<b>校验通过后</b>按 delete.mode 处理）</span>
        </label>

        <fieldset class="field">
          <legend>黑名单</legend>
          <label class="field__option">
            <input v-model="blacklistEnabled" type="checkbox" data-testid="blacklist-enabled" />
            <span>启用黑名单（跳过系统垃圾与你自定义规则命中的文件）</span>
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
            <span class="badge">{{ skipInfo.count }} 个文件已跳过（命中黑名单规则）</span>
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
