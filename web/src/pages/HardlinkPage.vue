<script setup>
// 硬链接去重页（docs/15 §三.前端）
//
// 交互红线（docs/15 §四，风险与 M5 同级）：
// - **dry-run 默认开启**：先看「能省多少」，scan 阶段永不改文件（服务端也只读）；
// - 执行前**强制确认弹窗**，文案写清不可逆合并的后果与适用范围（只读媒体）；
// - 结果按组展示：组内路径 + 大小 + 哈希校验状态；扩展名白名单可改（默认 7 类媒体）。
//
// 服务端不参与本页的"执行是否安全"判断的替代品——所有防线都在：scan 只读端点 +
// execute 的 confirmed 门卫 + 服务端重新全量哈希复核 + hardlink-*.jsonl 日志。

import { computed, ref } from 'vue';

import { scanHardlinkDuplicates, executeHardlinkGroups } from '../api/hardlink.js';
import { formatBytes } from '../utils/format.js';
import PromptDialog from '../components/common/PromptDialog.vue';

/** 默认扩展名（docs/15：mp4/mkv/avi/mov/iso/zip/7z） */
const DEFAULT_EXTENSIONS = 'mp4, mkv, avi, mov, iso, zip, 7z';

const scanPath = ref('/');
const extensionsDraft = ref(DEFAULT_EXTENSIONS);
const scanning = ref(false);
const scanError = ref('');
const scanResult = ref(null);
const selectedGroupIndexes = ref([]);
const executing = ref(false);
const executeError = ref('');
const executeNotice = ref('');
const confirmOpen = ref(false);
const executeResult = ref(null);

const extensionList = computed(() => extensionsDraft.value
  .split(',')
  .map((item) => item.trim().replace(/^\./, '').toLowerCase())
  .filter(Boolean));

const selectedGroups = computed(() => {
  if (!scanResult.value) return [];
  return selectedGroupIndexes.value
    .map((index) => scanResult.value.groups[index])
    .filter(Boolean);
});

const selectedSavedBytes = computed(() => selectedGroups.value.reduce((sum, group) => sum + (group.savedBytes || 0), 0));

const allSelected = computed(() => {
  if (!scanResult.value || scanResult.value.groups.length === 0) return false;
  return selectedGroupIndexes.value.length === scanResult.value.groups.length;
});

function toggleGroup(index) {
  const position = selectedGroupIndexes.value.indexOf(index);
  if (position >= 0) selectedGroupIndexes.value.splice(position, 1);
  else selectedGroupIndexes.value.push(index);
}

function toggleAll() {
  if (!scanResult.value) return;
  selectedGroupIndexes.value = allSelected.value ? [] : scanResult.value.groups.map((_, index) => index);
}

async function runScan() {
  scanning.value = true;
  scanError.value = '';
  scanResult.value = null;
  selectedGroupIndexes.value = [];
  executeResult.value = null;
  try {
    scanResult.value = await scanHardlinkDuplicates({ path: scanPath.value, extensions: extensionList.value });
    if (scanResult.value.groups.length === 0) selectedGroupIndexes.value = [];
  } catch (error) {
    scanError.value = error.message || '扫描失败';
  } finally {
    scanning.value = false;
  }
}

function openConfirm() {
  if (selectedGroups.value.length === 0) return;
  executeError.value = '';
  confirmOpen.value = true;
}

async function onConfirmExecute() {
  confirmOpen.value = false;
  executing.value = true;
  executeError.value = '';
  executeNotice.value = '';
  try {
    const result = await executeHardlinkGroups({
      path: scanPath.value,
      extensions: extensionList.value,
      groups: selectedGroups.value,
      confirmed: true,
    });
    executeResult.value = result;
    // 执行后重扫一次，让界面反映最新状态（已合并的组消失）
    await runScan();
    executeNotice.value = `已合并 ${result.executed} 个副本，释放 ${formatBytes(result.savedBytes)}`
      + (result.failed.length > 0 ? `；失败 ${result.failed.length} 条` : '')
      + (result.skippedGroups.length > 0 ? `；跳过 ${result.skippedGroups.length} 组（内容已变化）` : '');
  } catch (error) {
    executeError.value = error.message || '执行失败';
  } finally {
    executing.value = false;
  }
}
</script>

<template>
  <section class="card" data-testid="hardlink-page">
    <h3 class="card__title">硬链接去重</h3>
    <p class="card__desc">
      扫描目录内<b>内容完全相同</b>的文件副本，合并成一份物理数据（硬链接），省出整份空间。
      判定链：按大小分组 → 头尾+中间抽样快筛 → <b>全量 SHA-256 终判</b>（抽样不能判重复，
      同系列视频头尾一致但内容不同）。
    </p>

    <div class="hardlink-form">
      <label class="hardlink-form__row">
        <span>扫描目录</span>
        <input
          v-model="scanPath"
          type="text"
          data-testid="hardlink-path"
          placeholder="/media/movies"
        >
      </label>
      <label class="hardlink-form__row">
        <span>扩展名白名单（逗号分隔）</span>
        <input
          v-model="extensionsDraft"
          type="text"
          data-testid="hardlink-extensions"
        >
      </label>
      <button
        type="button"
        class="login-form__submit"
        data-testid="hardlink-scan"
        :disabled="scanning || !scanPath"
        @click="runScan"
      >
        {{ scanning ? '扫描中（大文件全量哈希可能较慢）…' : '开始扫描（只读，不改文件）' }}
      </button>
    </div>

    <p v-if="scanError" class="login-form__error" role="alert" data-testid="hardlink-scan-error">{{ scanError }}</p>

    <template v-if="scanResult">
      <div class="hardlink-summary" data-testid="hardlink-summary">
        <span>重复组：{{ scanResult.groups.length }}</span>
        <span>候选文件：{{ scanResult.stats.scanned }}</span>
        <span>可释放：{{ formatBytes(scanResult.stats.savedBytes) }}</span>
      </div>

      <div v-if="scanResult.groups.length > 0" class="hardlink-groups">
        <label class="hardlink-groups__all">
          <input
            type="checkbox"
            data-testid="hardlink-select-all"
            :checked="allSelected"
            @change="toggleAll"
          >
          全选（{{ selectedGroups.length }}/{{ scanResult.groups.length }} 组，可释放
          {{ formatBytes(selectedSavedBytes) }}）
        </label>

        <div
          v-for="(group, index) in scanResult.groups"
          :key="group.hash"
          class="hardlink-group"
          :class="{ 'hardlink-group--selected': selectedGroupIndexes.includes(index) }"
        >
          <label class="hardlink-group__head">
            <input
              type="checkbox"
              :data-testid="`hardlink-group-${index}`"
              :checked="selectedGroupIndexes.includes(index)"
              @change="toggleGroup(index)"
            >
            <b>{{ formatBytes(group.size) }}</b> × {{ group.duplicates.length + 1 }} 份
            → 释放 <b>{{ formatBytes(group.savedBytes) }}</b>
            <span class="badge">sha256 已校验</span>
          </label>
          <ul class="hardlink-group__paths">
            <li class="hardlink-group__master">{{ group.master }}（主文件，保留）</li>
            <li v-for="duplicate in group.duplicates" :key="duplicate">{{ duplicate }}（将被合并）</li>
          </ul>
        </div>

        <button
          type="button"
          class="login-form__submit"
          data-testid="hardlink-execute"
          :disabled="executing || selectedGroups.length === 0"
          @click="openConfirm"
        >
          {{ executing ? '执行中…' : `合并选中 ${selectedGroups.length} 组（释放 ${formatBytes(selectedSavedBytes)}）` }}
        </button>
      </div>
      <p v-else class="card__desc" data-testid="hardlink-empty">未发现重复副本。</p>
    </template>

    <p v-if="executeNotice" class="badge badge--ok" data-testid="hardlink-notice">{{ executeNotice }}</p>
    <p v-if="executeError" class="login-form__error" role="alert" data-testid="hardlink-execute-error">{{ executeError }}</p>

    <PromptDialog
      :open="confirmOpen"
      mode="confirm"
      danger
      title="确认合并重复文件？"
      label="建硬链接后，修改或删除其中任一文件会影响全部副本 —— 只对只读媒体（视频/镜像/压缩包等不再编辑的文件）使用。合并操作会写入服务端日志，可回滚排查但内容合并不可自动撤销。"
      :busy="executing"
      @confirm="onConfirmExecute"
      @cancel="confirmOpen = false"
    />
  </section>
</template>

<style scoped>
.hardlink-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0;
}

.hardlink-form__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hardlink-form__row input {
  padding: 8px 10px;
  border: 1px solid var(--color-border, #d0d3d9);
  border-radius: 6px;
}

.hardlink-summary {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding: 8px 0;
  font-weight: 600;
}

.hardlink-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hardlink-groups__all {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.hardlink-group {
  border: 1px solid var(--color-border, #d0d3d9);
  border-radius: 8px;
  padding: 10px;
}

.hardlink-group--selected {
  border-color: var(--color-primary, #2f6fed);
}

.hardlink-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hardlink-group__paths {
  margin: 8px 0 0;
  padding-left: 28px;
  word-break: break-all;
}

.hardlink-group__master {
  font-weight: 600;
}
</style>
