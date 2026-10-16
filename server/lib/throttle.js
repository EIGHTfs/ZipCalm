// 进度节流器（≥100ms 或跨过阈值才回调）
//
// 为什么需要：压缩/解压都对每个条目、每个字节块产生事件；如果每次都广播给任务层，
// SSE 与前端会被刷爆（docs/05 §一：事件驱动 + 节流，不是定时采样）。
// 契约要求字节级进度按 ≥100ms 节流（插件契约 §3.4 第 3 条）。

/**
 * 包装一个进度回调，使其按最小间隔节流；但**文件级变化（currentFile 改变 / 计数变化）永远立即放行**，
 * 这样"当前正在处理哪个文件"不会因为节流而滞后。
 * @param {(payload: object) => void} sink
 * @param {{intervalMs?: number}} [options]
 */
export function createThrottledReporter(sink, options = {}) {
  const intervalMs = Number.isInteger(options.intervalMs) ? options.intervalMs : 100;
  let lastEmitAt = 0;
  let lastKey = '';
  let pending = null;

  function emit(payload, force) {
    lastEmitAt = Date.now();
    pending = null;
    lastKey = `${payload.processedFiles}|${payload.currentFile}|${payload.stage || ''}`;
    sink(payload);
  }

  return function report(payload) {
    const key = `${payload.processedFiles}|${payload.currentFile}|${payload.stage || ''}`;
    const now = Date.now();

    // 阶段/文件级变化 → 立即上报（保证"当前文件名"实时）
    if (key !== lastKey) {
      emit(payload, true);
      return;
    }
    // 纯字节级变化 → 按间隔节流
    if (now - lastEmitAt >= intervalMs) {
      emit(payload, false);
      return;
    }
    pending = payload;
  };
}
