#!/bin/bash
# 验收脚本共用的测试账号（M1 / 验收探测 / M3 崩溃恢复三个脚本原先各写一份默认值，会漂移）
#
# 为什么明文必须存在：
#   - 运行期配置 storage/config.json 只存 `auth.passwordHash`（scrypt 哈希，不可反推明文）
#   - config.example.json 的 `auth.password` 是空占位
#   脚本要能自动登录，就只能自带默认值。该默认值 = 项目自带的**演示账号**（README 快速开始同值），
#   不是任何真实凭据。
#
# 关于审计（security/secret-keyvalue）：
#   规则正确命中「key=<引号字面量>」这种形状（真命中，不是误报），而演示账号属设计使然。
#   处置 = 按规则自身的豁免机制，在本行**行尾**标 dsh-skip-sensitive 并写明理由：
#   插件 lib/exempt/index.js 的 sensitiveRules 含 'secret'，且该标记 lineLevel=true
#   ⇒ 只免「这一行」，不影响本文件其余检查，也不改变审计逻辑。
#   （不采用"拼接字符串/换变量名躲避正则"之类的写法：那是绕规则，不是处置。）
#
# 覆盖方式（优先级从高到低）：
#   ZC_TEST_USER / ZC_TEST_PASSWORD            —— 通用名
#   ZIPCALM_TEST_USER / ZIPCALM_TEST_PASSWORD  —— M1 脚本沿用的旧名，继续兼容

TEST_USER="${ZC_TEST_USER:-${ZIPCALM_TEST_USER:-admin}}"
if [ -n "${ZC_TEST_PASSWORD:-}" ]; then
  TEST_PASSWORD="${ZC_TEST_PASSWORD}"
elif [ -n "${ZIPCALM_TEST_PASSWORD:-}" ]; then
  TEST_PASSWORD="${ZIPCALM_TEST_PASSWORD}"
else
  TEST_PASSWORD='zipcalm' # dsh-skip-sensitive: 项目自带演示账号默认值（与 README 快速开始一致，非真实凭据）
fi
