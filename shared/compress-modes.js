// 压缩模式枚举（前后端共用的唯一来源）
//
// 依据：docs/M0/数据模型.md §一「shared/compress-modes.js」+ docs/04「两种压缩模式」。
// single = 每个源各自一个压缩包；bundle = 所有源合成一个压缩包。
// 注意：两种模式是互斥的任务模型（docs/04 §一），UI 用单选，不用两个按钮。

export const COMPRESS_MODE = Object.freeze({
  SINGLE: 'single',
  BUNDLE: 'bundle',
});

export const COMPRESS_MODE_VALUES = Object.freeze(Object.values(COMPRESS_MODE));

// 默认模式：docs/08 第八节「默认值预设合理：模式单独压缩」
export const COMPRESS_MODE_DEFAULT = COMPRESS_MODE.SINGLE;

export const COMPRESS_MODE_LABELS = Object.freeze({
  [COMPRESS_MODE.SINGLE]: '每个文件/文件夹单独压缩',
  [COMPRESS_MODE.BUNDLE]: '合并为一个压缩包',
});

// 一句话说明：用于压缩抽屉里的辅助文案
export const COMPRESS_MODE_HINTS = Object.freeze({
  [COMPRESS_MODE.SINGLE]: '选中的每一项各自生成一个压缩包，产物名与源同名',
  [COMPRESS_MODE.BUNDLE]: '所有选中项打包进同一个压缩包，包内保留目录结构',
});

export function isCompressMode(value) {
  return COMPRESS_MODE_VALUES.includes(value);
}

export function compressModeLabel(mode) {
  return COMPRESS_MODE_LABELS[mode] || '未知模式';
}

export function compressModeHint(mode) {
  return COMPRESS_MODE_HINTS[mode] || '';
}
