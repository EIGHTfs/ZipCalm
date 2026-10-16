// 任务事件总线（SSE 的"发布/订阅"内核，docs/M0/API规范.md §五）
//
// 设计要点（每条都对着契约条款）：
// - `seq` 单调递增：每个事件一个序号，客户端用 `since=<seq>` 续传（§五 规则 2）；
// - 环形缓冲保留最近 `retention`（默认 1000）条：`since` 落在窗口内 → 补发增量；
//   落在窗口外 → 调用方改发 `snapshot`（丢事件不丢状态，§五 规则 1/2）；
// - 死订阅者自愈：`send()` 返回 false 或抛错即剔除，单个坏连接不影响其他订阅者（§五 规则 4）；
// - **与任务执行零耦合**：零订阅者照常发布（发布只入环形缓冲），任务该跑还跑（INV-02/INV-04）。
//
// 结构：状态集中在 ctx，扇出/续传等动作是模块级函数；工厂只做装配与暴露最小 API。

/** 事件 → 频道映射（心跳/error 属连接级，不按频道过滤） */
const CHANNEL_OF = { snapshot: 'tasks', task: 'tasks', metrics: 'metrics' };

/** 扇出：写失败/返回 false 的订阅者立即剔除（自愈） */
function fanOut(ctx, frame) {
  const dead = [];
  for (const subscriber of ctx.subscribers) {
    if (subscriber.channels && frame.channel && !subscriber.channels.includes(frame.channel)) continue;
    try {
      if (subscriber.send(frame) === false) dead.push(subscriber);
    } catch {
      dead.push(subscriber);
    }
  }
  for (const subscriber of dead) {
    ctx.subscribers.delete(subscriber);
    ctx.logger.warn('SSE 订阅者写入失败，已剔除', { remaining: ctx.subscribers.size });
  }
}

/**
 * 续传：返回 seq > since 的缓冲事件。
 * `since` 早于缓冲窗口起点 → 返回 null（调用方应改发 snapshot，§五 规则 2）。
 */
function replayFromRing(ctx, since) {
  if (!Number.isInteger(since)) return null;
  const oldest = ctx.ring.length > 0 ? ctx.ring[0].seq : ctx.seq + 1;
  if (since < oldest - 1) return null;
  return ctx.ring.filter((frame) => frame.seq > since);
}

/**
 * @param {{retention?: number, logger: object}} options
 */
export function createTaskEvents(options) {
  const ctx = {
    logger: options.logger,
    retention: Number.isInteger(options.retention) ? options.retention : 1000,
    seq: 0,
    /** 环形缓冲：{ seq, event, channel, data }（data 已含 seq） */
    ring: [],
    /** Set<{channels: string[], send: (frame) => boolean}> */
    subscribers: new Set(),
  };

  function publish(event, data) {
    ctx.seq += 1;
    const frame = { seq: ctx.seq, event, channel: CHANNEL_OF[event] || null, data: { ...data, seq: ctx.seq } };
    ctx.ring.push(frame);
    if (ctx.ring.length > ctx.retention) ctx.ring.shift();
    fanOut(ctx, frame);
    return frame.seq;
  }

  /** 注册订阅者；返回退订函数（连接断开时必须调用，防泄漏） */
  function subscribe(subscriber) {
    ctx.subscribers.add(subscriber);
    return () => {
      ctx.subscribers.delete(subscriber);
    };
  }

  return {
    publish,
    subscribe,
    replaySince: (since) => replayFromRing(ctx, since),
    subscriberCount: () => ctx.subscribers.size,
    currentSeq: () => ctx.seq,
    retention: ctx.retention,
  };
}
