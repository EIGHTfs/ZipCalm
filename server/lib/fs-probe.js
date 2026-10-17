/*
 * 文件系统探测小工具（**一律异步**）
 *
 * 为什么单独收成一模块：服务端的这些探测几乎都发生在**请求路径**或**任务执行路径**上，
 * `existsSync` / `statSync` 会把事件循环钉住（一次系统调用不慢，但它们在循环与并发请求里会被放大）；
 * 而且它们被多个模块各写一份（预检、产物命名、创建守卫、落盘计划）—— 收成一处才不会"改一处忘一处"。
 */

import fsp from 'node:fs/promises';

/**
 * 路径是否存在。
 * 语义与 `existsSync` 对齐：任何访问失败（ENOENT / EACCES / ENOTDIR …）都算"不存在"，
 * 不区分失败原因（需要区分原因的调用方请直接用 fsp.stat/access 并自行处理错误）。
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}
