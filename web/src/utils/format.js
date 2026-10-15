// 展示层格式化工具（docs/12 §三 web/src/utils/format.js · Vue 3 版）
//
// 技术栈约定：字节用 **pretty-bytes**，时间用 **dayjs**（优先成熟库，不自研）。
//
// 契约约束（docs/M0/API规范.md §一）：
// - 时间一律 **Unix 毫秒整数** → 用 dayjs(ms) 解析；
// - 字节一律 **整数 bytes** → 用 prettyBytes 渲染；
// - 这里不做单位解析、不接受 "1.5MB" 这类字符串（避免两端各自猜格式）。
// 所有函数对非法输入统一返回 '—'，防止页面出现 undefined/NaN。

import prettyBytes from 'pretty-bytes';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import 'dayjs/locale/zh-cn.js';

// 相对时间（"3 分钟前"）需要插件；中文文案用 zh-cn locale
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const PLACEHOLDER = '—';

/**
 * 字节数格式化（pretty-bytes，1024 进制，本地化数字）。
 * @param {number} bytes 整数字节
 * @returns {string} 例如 1610612736 → '1.5 GB'
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER;
  try {
    return prettyBytes(bytes, { locale: 'zh-CN', binary: false });
  } catch {
    // 极端环境下 Intl 不可用时退回不带本地化的输出
    return prettyBytes(bytes);
  }
}

/**
 * 千分位整数格式化（条目数、文件数）。
 * @param {number} count
 * @returns {string} 例如 12345 → '12,345'
 */
export function formatCount(count) {
  if (!Number.isFinite(count)) return PLACEHOLDER;
  return Math.round(count).toLocaleString('zh-CN');
}

/**
 * 百分比格式化（进度用），夹取到 0~100。
 * @param {number} value 0~100
 * @returns {string} 例如 42.53 → '42.5%'
 */
export function formatPercent(value) {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  const clamped = Math.min(100, Math.max(0, value));
  return `${Number(clamped.toFixed(1))}%`;
}

/**
 * 时长格式化（任务耗时、ETA）。
 * @param {number} ms 毫秒
 * @returns {string} 例如 84210 → '1 分 24 秒'
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return PLACEHOLDER;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * 时间格式化（Unix 毫秒 → 本地时间字符串）。
 * @param {number|null|undefined} ms
 * @param {string} [template]
 * @returns {string} 例如 '2026-10-16 02:30'
 */
export function formatDateTime(ms, template = 'YYYY-MM-DD HH:mm') {
  if (!Number.isFinite(ms)) return PLACEHOLDER;
  const value = dayjs(ms);
  return value.isValid() ? value.format(template) : PLACEHOLDER;
}

/**
 * 完整时间（含秒），用于日志/详情。
 * @param {number} ms
 */
export function formatDateTimeFull(ms) {
  return formatDateTime(ms, 'YYYY-MM-DD HH:mm:ss');
}

/**
 * 相对时间（"3 分钟前"），任务列表与「最近完成」卡片用。
 * @param {number} ms Unix 毫秒
 * @returns {string}
 */
export function formatRelativeTime(ms) {
  if (!Number.isFinite(ms)) return PLACEHOLDER;
  const value = dayjs(ms);
  if (!value.isValid()) return PLACEHOLDER;
  // 未来时间不给「xx 后」，直接显示绝对时间，避免时钟漂移显示成笑话
  if (value.valueOf() > Date.now()) return formatDateTime(ms);
  return value.fromNow();
}

/**
 * 速率格式化（字节/秒），看板与任务进度共用。
 * @param {number} bytesPerSecond
 * @returns {string} 例如 27114296 → '25.9 MB/s'
 */
export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return PLACEHOLDER;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 统一的空值占位符：页面需要「没有数据」时用它，而不是空字符串 */
export const EMPTY_PLACEHOLDER = PLACEHOLDER;
