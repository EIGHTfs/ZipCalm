// dsh-skip-sensitive: 本文件只定义能力参数的字段名常量（PASSWORD: 'password' / HAS_PASSWORD: 'hasPassword'），不含任何凭据值；规则按关键字命中属误报
// 能力枚举与字段名（docs/19 §三：前后端共用的能力契约，单一来源）
//
// 「能力插件」是压缩之外的可插拔功能（首个：password 加密密码）。
// 本文件只定义**枚举与字段名**；能力的行为由 server/plugins/capabilities/<id>/ 实现，
// 前端不硬编码能力列表——运行时从 GET /api/v1/capabilities/:id 拉取。

/** 已知能力 id（白名单：capRegistry 只加载这里的 id 对应目录） */
export const CAPABILITY_IDS = Object.freeze(['password']);

/** 能力参数的字段名（前后端共用以避免字符串漂移） */
export const CAPABILITY_FIELDS = Object.freeze({
  PASSWORD: 'password',
  METHOD: 'method',
});

/** 任务 options 上与能力相关的**脱敏后**字段（明文不落盘，docs/19 §六） */
export const OPTION_REDACTED_FIELDS = Object.freeze({
  HAS_PASSWORD: 'hasPassword',
  PASSWORD_METHOD: 'passwordMethod',
});
