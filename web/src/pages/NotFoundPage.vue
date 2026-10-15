<script setup>
// 404 页（路由兜底）
//
// 为什么要有：hash 路由手输错误地址时不能白屏；同时给用户一个回主线的出口。

import { RouterLink } from 'vue-router';

import { ROUTES } from '../constants/index.js';
</script>

<template>
  <section class="card">
    <h3 class="card__title">页面不存在</h3>
    <p class="card__desc">地址可能输错了，或该功能还没实现（当前处于 F1 前端准备块阶段）。</p>
    <p style="margin-top: var(--space-3)">
      <RouterLink :to="ROUTES.FILES">返回文件浏览</RouterLink>
    </p>
  </section>
</template>
