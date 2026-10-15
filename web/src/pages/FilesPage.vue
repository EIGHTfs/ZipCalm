<script setup>
// 文件浏览页（占位）：M1 接入 GET /api/v1/fs/list + /fs/stat
//
// F1 只做「看得出这是文件页」的骨架：工具条占位 + 空状态卡片 + 占位网格。
// 不写死任何枚举字面量（黑名单/格式相关的展示全部读 shared/ 或 constants/）。

import { formatBytes } from '../utils/format.js';
import { FORMATS } from '../constants/index.js';
</script>

<template>
  <section class="card">
    <h3 class="card__title">文件浏览</h3>
    <p class="card__desc">
      F1 仅占位。M1 起接入 <code>/api/v1/fs/list</code>（列目录）与
      <code>/api/v1/fs/stat</code>（条目详情），路径一律为「相对存储根的 POSIX 路径」，
      根为 <code>/</code>。
    </p>
  </section>

  <section class="card">
    <h3 class="card__title">压缩产物命名规则（契约预览）</h3>
    <p class="card__desc">
      单项：<code>&lt;源名&gt;&lt;扩展名&gt;</code>；多项打包：
      <code>&lt;首个源名&gt; 等 N 项&lt;扩展名&gt;</code>；同名时自动追加
      <code> (1)</code>、<code> (2)</code> —— 绝不覆盖既有文件。
    </p>
    <div class="placeholder-grid" style="margin-top: var(--space-4)">
      <div v-for="format in FORMATS" :key="format.id" class="placeholder-block">
        <strong>{{ format.name }}</strong> · {{ format.ext }}<br />
        <span>{{ format.mime }}</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h3 class="card__title">预检提示（M6 会用到）</h3>
    <p class="card__desc">
      启动压缩前，服务端会校验「剩余空间 ≥ 待压文件 × 2」；被黑名单跳过的文件保留在原目录、
      不进压缩包、也永远不会被删除。示例展示：{{ formatBytes(5368709120) }} 的目录需要约
      {{ formatBytes(10737418240) }} 可用空间。
    </p>
  </section>
</template>
