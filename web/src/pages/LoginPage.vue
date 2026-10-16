<script setup>
// 登录页（M1：真实调 POST /api/v1/auth/login）
//
// 流程：提交 → session.login() → 成功后 replace 到 redirect（或文件页）。
// 失败时展示后端返回的**契约错误码 + message**（不吞错、不猜文案）。
// 校验：用户名/密码非空在本地先拦一层，避免无意义的请求。

import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useSessionStore } from '../stores/session.js';
import { APP_NAME, APP_NAME_ZH, ROUTES } from '../constants/index.js';

const router = useRouter();
const route = useRoute();
const session = useSessionStore();

const username = ref('');
const password = ref('');
const submitting = ref(false);
const errorText = ref('');

/** 登录成功后的落点：优先 redirect（路由守卫带过来的），否则文件页 */
function resolveRedirect() {
  const redirect = route.query.redirect;
  if (typeof redirect === 'string' && redirect.startsWith('/')) return redirect;
  return ROUTES.FILES;
}

async function handleSubmit() {
  if (submitting.value) return;

  const user = username.value.trim();
  if (!user || !password.value) {
    errorText.value = '请输入用户名与密码';
    return;
  }

  submitting.value = true;
  errorText.value = '';
  try {
    await session.login(user, password.value);
    password.value = ''; // 成功后立刻清掉内存里的明文
    await router.replace(resolveRedirect());
  } catch (error) {
    errorText.value = error && error.code
      ? `[${error.code}] ${error.message || '登录失败'}`
      : (error && error.message) || '登录失败，请重试';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page" data-testid="login-page">
    <section class="card login-card">
      <h1 class="login-card__brand">
        {{ APP_NAME }}
        <span class="topbar__brand-sub">{{ APP_NAME_ZH }}</span>
      </h1>
      <p class="card__desc">登录后即可浏览存储根目录下的文件（M1：浏览 + 认证）。</p>

      <form class="login-form" data-testid="login-form" @submit.prevent="handleSubmit">
        <label class="login-form__label" for="login-username">用户名</label>
        <input
          id="login-username"
          v-model="username"
          name="username"
          type="text"
          autocomplete="username"
          placeholder="admin"
          :disabled="submitting"
        />

        <label class="login-form__label" for="login-password">密码</label>
        <input
          id="login-password"
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="密码"
          :disabled="submitting"
        />

        <p v-if="errorText" class="login-form__error" data-testid="login-error" role="alert">
          {{ errorText }}
        </p>

        <button type="submit" class="login-form__submit" :disabled="submitting" data-testid="login-submit">
          {{ submitting ? '登录中…' : '登录' }}
        </button>
      </form>
    </section>
  </div>
</template>
