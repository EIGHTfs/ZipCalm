/*
 * 验收脚本共用的运行期配置读取
 *
 * 为什么抽出来：四套脚本各抄了一份同样的 IIFE（读 storage/config.json、失败就返回 {}），
 * 审计的 no-duplicate-code 会命中；而且"读不到配置就退回默认"的策略应该只有一处实现。
 *
 * 注意：这里只读**运行期配置**（storage/config.json，含部署方改过的端口/存储根），
 * 不是仓库里的 config.example.json —— 测试要跟随当前实例的真实配置。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} projectRoot 项目根目录
 * @returns {Promise<object>} 配置对象；文件缺失或不是合法 JSON 时返回 {}（测试脚本不该因此挂掉）
 */
export async function loadRuntimeConfig(projectRoot) {
  try {
    return JSON.parse(await fsp.readFile(path.join(projectRoot, 'storage', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}
