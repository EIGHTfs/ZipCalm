// 流工具（各格式包共用的小工具）
//
// 为什么要单独抽一个 `pipelineWith`：`stream.pipeline(a, b, undefined)` **不是"没有选项"**，
// 而是把 `undefined` 当成一个 stage 去校验并抛
// `The "body" argument must be of type function or ... Received undefined`。
// 而"有取消信号时传 { signal }、没有时不传"是很自然的写法 —— 一不留神就写成了三元表达式带 undefined。
// 实测踩过：M4 的 tar 系列在没有信号时崩在这里（zip 侧因为运行期总有信号，一直没暴露）。

import { pipeline } from 'node:stream/promises';

/**
 * 按需附加 `{ signal }` 的 pipeline（signal 为空时不传第三个参数）。
 * @param {Array} stages 至少两个流（最后一个是目标）
 * @param {AbortSignal} [signal]
 */
export function pipelineWith(stages, signal) {
  return signal ? pipeline(...stages, { signal }) : pipeline(...stages);
}
