// 硬链接预检提示的共享契约：阈值与格式名单只在这里定义，前后端同源、避免各写一套漂移。
// 提示不改任何空间判定（INV-07 原样）：zip 逐条累加恰好准确、tar 偏保守但不会漏拦。
// 判定依据只有一条 —— 同 dev 且同 ino 才是硬链接（跨分区相同 ino 是巧合）。

/** 提示阈值：当前格式会"多存"的字节占逻辑大小 ≥ 该比例时才提示（低于它属噪声） */
export const HARDLINK_HINT_MIN_RATIO = 0.1;

/** 保留硬链接的格式（tar 家族；zip 不保留） */
export const HARDLINK_PRESERVING_FORMATS = Object.freeze(['tar', 'targz', 'tarzst']);

/** 未知格式按"不保留"处理：宁可多提示一次，也不让用户以为省了空间。 */
export function formatPreservesHardlinks(formatId) {
  return HARDLINK_PRESERVING_FORMATS.includes(String(formatId || '').toLowerCase());
}

/** 是否值得提示（仅格式不保留硬链接时使用）：差异太小就不打扰。 */
export function shouldHintHardlink({ logicalBytes, duplicatedBytes }) {
  if (!Number.isFinite(logicalBytes) || logicalBytes <= 0) return false;
  if (!Number.isFinite(duplicatedBytes) || duplicatedBytes <= 0) return false;
  return duplicatedBytes / logicalBytes >= HARDLINK_HINT_MIN_RATIO;
}
