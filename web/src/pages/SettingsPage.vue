<script setup>
// 设置页 · 黑名单管理（M6）
//
// 契约（docs/M0/API规范.md §4.5、docs/04 §三）：
// - GET /blacklist 读三层：global（内置、locked、不可改）、user（可增删、全量替换）、effectiveCount
// - PUT /blacklist/user 全量替换（幂等）；校验由服务端做（单条 ≤128、总数 ≤200、拒绝路径分隔符）
// - 任务级临时层（extraPatterns）不在本页维护：它属于"这一次压缩"的参数，只出现在压缩抽屉
//
// 设计要点：全局层是只读的（locked），页面必须把它和用户层**分开呈现**，否则用户会以为能删内置项；
// 每次增删都走"全量替换"（服务端契约如此），所以前端只维护一份 patterns 数组并整份提交。

import { computed, onMounted, ref } from 'vue';

import { api } from '../api/client.js';
import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();

const loading = ref(false);
const saving = ref(false);
const errorText = ref('');
const noticeText = ref('');

const globalLayer = ref({ locked: true, enabled: true, patterns: [] });
const userLayer = ref({ enabled: true, patterns: [], updatedAt: null });
const effectiveCount = ref(0);
const draftPattern = ref('');

const userPatterns = computed(() => (userLayer.value && userLayer.value.patterns) || []);
const updatedText = computed(() => {
  const at = userLayer.value && userLayer.value.updatedAt;
  if (!at) return '尚未保存过';
  return new Date(at).toLocaleString('zh-CN');
});

/** 读三层（错误就地展示，不吞） */
async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const layersDoc = await api.get('/blacklist');
    globalLayer.value = (layersDoc && layersDoc.global) || globalLayer.value;
    userLayer.value = (layersDoc && layersDoc.user) || userLayer.value;
    effectiveCount.value = Number((layersDoc && layersDoc.effectiveCount) || 0);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    loading.value = false;
  }
}

/** 全量替换用户层（增/删/开关都走它：契约只提供这一个写入口） */
async function saveUser(nextPatterns, nextEnabled = userLayer.value.enabled) {
  saving.value = true;
  errorText.value = '';
  noticeText.value = '';
  try {
    const savedUser = await api.put('/blacklist/user', {
      patterns: nextPatterns,
      enabled: nextEnabled !== false,
    });
    userLayer.value = (savedUser && savedUser.user) || userLayer.value;
    noticeText.value = '已保存（立即生效）';
    await load(); // effectiveCount 会变，重新读一次保持界面一致
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    saving.value = false;
  }
}

/** 新增一条：去掉首尾空白；重复的不再添加（服务端也会去重，这里提前给用户反馈） */
async function addPattern() {
  const pattern = draftPattern.value.trim();
  if (!pattern) {
    errorText.value = '请输入扩展名（如 *.bak）或文件名（如 Thumbs.db）';
    return;
  }
  if (userPatterns.value.some((item) => item.toLowerCase() === pattern.toLowerCase())) {
    errorText.value = `已存在同名规则：${pattern}`;
    return;
  }
  await saveUser([...userPatterns.value, pattern]);
  if (!errorText.value) draftPattern.value = '';
}

/** 删除一条 */
async function removePattern(pattern) {
  await saveUser(userPatterns.value.filter((item) => item !== pattern));
}

/** 用户层开关（关掉后用户规则不参与匹配；全局层的开关不落盘，见压缩抽屉的说明） */
async function toggleUserLayer(event) {
  await saveUser(userPatterns.value, Boolean(event.target.checked));
}

onMounted(load);
</script>

<template>
  <section class="card" data-testid="settings-blacklist">
    <h3 class="card__title">黑名单</h3>
    <p class="card__desc">
      已压缩格式再压几乎没有收益（jpg/mp4/zip/docx…）。命中黑名单的文件会被<b>跳过</b>：
      不进压缩包、也不会被「删除原文件」删掉。匹配由服务端完成（客户端不参与判定）。
    </p>

    <p v-if="loading" class="card__desc">读取中…</p>
    <p v-if="errorText" class="login-form__error" role="alert" data-testid="blacklist-error">{{ errorText }}</p>
    <p v-if="noticeText" class="badge badge--ok" data-testid="blacklist-notice">{{ noticeText }}</p>
  </section>

  <section class="card">
    <h3 class="card__title">全局默认 <span class="badge">locked</span></h3>
    <p class="card__desc">
      内置规则，<b>不可增删改</b>（已压缩格式 + 系统垃圾）。想压这些文件时，在压缩抽屉里关掉「启用黑名单」即可。
    </p>
    <div class="tree" data-testid="blacklist-global">
      <span v-for="pattern in globalLayer.patterns" :key="pattern" class="badge">{{ pattern }}</span>
      <span v-if="globalLayer.patterns.length === 0" class="card__desc">（服务端未返回内置规则）</span>
    </div>
  </section>

  <section class="card">
    <h3 class="card__title">用户自定义</h3>
    <p class="card__desc">
      保存在服务端 <code>storage/blacklist-user.json</code>，立即生效（当前 {{ userPatterns.length }} 条 · 共 {{ effectiveCount }} 条有效规则 · 上次保存：{{ updatedText }}）。
    </p>

    <label class="field__option">
      <input
        type="checkbox"
        :checked="userLayer.enabled !== false"
        :disabled="saving"
        data-testid="blacklist-user-enabled"
        @change="toggleUserLayer"
      />
      <span>启用用户自定义层（关掉后只有全局默认生效）</span>
    </label>

    <div class="field__option">
      <input
        v-model="draftPattern"
        type="text"
        placeholder="例如 *.bak 或 Thumbs.db"
        data-testid="blacklist-input"
        :disabled="saving"
        @keyup.enter="addPattern"
      />
      <button type="button" class="login-form__submit" data-testid="blacklist-add" :disabled="saving" @click="addPattern">
        添加
      </button>
    </div>
    <p class="field__hint">支持三种写法：<code>*.扩展名</code>（大小写不敏感）、精确文件名、目录名（如 <code>@eaDir</code>）。不允许包含路径分隔符。</p>

    <ul class="tree" data-testid="blacklist-user-list">
      <li v-for="pattern in userPatterns" :key="pattern" class="tree__item">
        <span class="badge">user</span>
        <code>{{ pattern }}</code>
        <button
          type="button"
          class="badge badge--warn"
          :disabled="saving"
          :data-testid="`blacklist-remove-${pattern}`"
          @click="removePattern(pattern)"
        >
          删除
        </button>
      </li>
      <li v-if="userPatterns.length === 0" class="tree__item">
        <span class="card__desc">还没有自定义规则。</span>
      </li>
    </ul>
  </section>

  <section class="card">
    <h3 class="card__title">界面偏好（已是真交互）</h3>
    <p class="card__desc">
      当前视图模式：<strong>{{ ui.viewMode }}</strong>（顶部栏可切换；该状态存在 pinia，
      未登录也不影响）。深色模式属 M8 范围。
    </p>
  </section>
</template>
