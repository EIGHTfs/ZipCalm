// Vite 构建配置（F1 前端准备块 · Vue 3 版）
//
// 关键约定（task-2 第一节钉死）：
// - root 指向 web/：入口是 web/index.html，而 package.json 在项目根。
// - 必须挂 @vitejs/plugin-vue，否则 .vue SFC 无法解析。
// - build.outDir 相对 root 解析 → 实际产物落在 web/dist。
// - dev 端口固定 5180；host 用布尔值（不写死 IP），便于用局域网地址实测。
// - @shared 别名指向项目根的 shared/：前后端共用枚举只有一份，不复制进 web/。
// - server.fs.allow 放宽到上一级：root 在 web/ 内，需要读取 root 之外的 shared/。

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// web/ 目录（由本配置文件位置推导，不手写绝对路径）
const webRoot = fileURLToPath(new URL('.', import.meta.url));
// 项目根的 shared/
const sharedDir = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  root: webRoot,

  plugins: [vue()],

  resolve: {
    alias: {
      '@shared': sharedDir,
    },
  },

  build: {
    outDir: 'dist', // → web/dist
    emptyOutDir: true,
    // 不产出 sourcemap：
    //   ① 体积 —— .map 约 1.8 MB，是压缩后 js（328 KB）的 5 倍，占 npm 包体积约 65%
    //   ② 泄漏构建机目录结构 —— map 的 sources 会记下 `../../../../../zipcalm-build/node_modules/...`
    //      这类路径，等于把本机组织方式暴露给所有下载包的人
    //   ③ 对使用者价值有限 —— 本包用于"跑服务"；前端问题在浏览器 DevTools 看即可，
    //      真要还原堆栈，从源码仓库（web/src 全在 git 里）拿比塞进发行包合适
    // 排查线上前端问题若确实需要，可临时改回 true 单独构建一份，不必随包分发。
    sourcemap: false,
  },

  server: {
    port: 5180,
    strictPort: true, // 端口被占用直接失败，避免"悄悄换端口"导致验证地址对不上
    host: true, // 监听所有网卡（布尔值，不写死 IP）
    fs: {
      allow: ['..'], // 允许读取 root 之外的 shared/
    },
  },

  preview: {
    port: 5180,
    strictPort: true,
  },
});
