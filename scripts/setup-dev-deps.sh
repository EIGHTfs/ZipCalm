#!/usr/bin/env bash
#
# ZipCalm 开发依赖安装脚本（方案 A：依赖装在可执行盘，工作区只留软链）
#
# ── 为什么需要这个脚本（实测结论，不是猜测）──────────────────────────────
# 1. 工作区目录挂载为 NFS 且带 noexec：
#      sa6400:/volume13/... on /volume1/VirtualDSM/DeepSeekHarness/工作区 type nfs (rw,nodev,noexec)
#    /tmp 同样是 noexec。后果：node_modules 里的原生二进制（esbuild 等）在工作区内
#    无法执行（execve 返回 EACCES / shell 报 exit 126）。
# 2. 直接在项目根跑 `npm install` 会失败：npm 10 的 reify 阶段会执行
#      npm warn reify Removing non-directory <项目根>/node_modules
#    —— 它把项目根的 node_modules 软链当作"非目录"删掉，然后在 noexec 的工作区内
#    建真实目录，esbuild 的 postinstall 紧接着 EACCES（spawnSync ... EACCES）。
# 3. 因此采用方案 A：**npm install 只在可执行盘内执行**，
#    项目根只保留一个指向它的软链；`npm run dev|build` 照常在项目根跑
#    （npm run 不触发 reify，软链不会被删）。
#
# ── 红线 ──────────────────────────────────────────────────────────────
# - 不要在项目根直接执行 `npm install` / `npm ci`（会删掉软链并重新装到 noexec 盘）。
# - 源码始终留在工作区（shared/、web/、scripts/、package.json）；只有依赖落在构建目录。
# - package-lock.json 留在构建目录，不入库。
#
# ── 用法 ──────────────────────────────────────────────────────────────
#   bash scripts/setup-dev-deps.sh                     # 默认依赖目录 /volume1/@tmp/zipcalm-build
#   ZIPCALM_BUILD_DIR=/some/exec/path bash scripts/setup-dev-deps.sh   # 覆盖依赖目录
#   脚本幂等：可重复执行，每次都重建软链并复跑安装。
#
set -euo pipefail

# 项目根 = 本脚本所在目录的上一级（由脚本自身位置推导，不写死绝对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 依赖目录：默认落在本机可执行盘，可通过环境变量覆盖（不写死）
BUILD_DIR="${ZIPCALM_BUILD_DIR:-/volume1/@tmp/zipcalm-build}"

echo "[setup-dev-deps] 项目根：${PROJECT_ROOT}"
echo "[setup-dev-deps] 依赖目录：${BUILD_DIR}（可用 ZIPCALM_BUILD_DIR 覆盖）"

# ── 1. 准备构建目录，并同步 package.json ────────────────────────────────
# 依赖声明的唯一来源仍是项目根 package.json；这里只是复制一份给安装用。
mkdir -p "${BUILD_DIR}"
cp "${PROJECT_ROOT}/package.json" "${BUILD_DIR}/package.json"

# ── 2. 在可执行盘内安装依赖 ─────────────────────────────────────────────
echo "[setup-dev-deps] 在依赖目录执行 npm install ..."
(
  cd "${BUILD_DIR}"
  npm install --no-audit --no-fund
)

# ── 3. 重建项目根软链 ───────────────────────────────────────────────────
# 先删再建：npm 曾把软链当作"非目录"删除，所以每次执行都重建一遍。
NODE_MODULES_LINK="${PROJECT_ROOT}/node_modules"
if [ -L "${NODE_MODULES_LINK}" ]; then
  rm -f "${NODE_MODULES_LINK}"
elif [ -d "${NODE_MODULES_LINK}" ]; then
  # 安全兜底：真实目录绝不静默删除（可能装了几百 MB 依赖，需人工确认）
  echo "[setup-dev-deps] 错误：${NODE_MODULES_LINK} 是真实目录而非软链。" >&2
  echo "[setup-dev-deps] 请人工确认后移走/删除它，再重跑本脚本（脚本不会自动删目录）。" >&2
  exit 1
fi
ln -sfn "${BUILD_DIR}/node_modules" "${NODE_MODULES_LINK}"

# ── 4. 自检：软链可达 + vite 入口存在 + 原生二进制可执行 ────────────────
echo "[setup-dev-deps] 自检中 ..."
if [ ! -e "${NODE_MODULES_LINK}/vite/package.json" ]; then
  echo "[setup-dev-deps] 错误：软链下找不到 vite，安装可能不完整。" >&2
  exit 1
fi

ESBUILD_BIN="$(ls -d "${BUILD_DIR}"/node_modules/@esbuild/*/bin/esbuild 2>/dev/null | head -n 1 || true)"
if [ -n "${ESBUILD_BIN}" ]; then
  # 这一步就是此前的失败点：验证原生二进制在依赖目录里能真正执行
  if ! "${ESBUILD_BIN}" --version >/dev/null 2>&1; then
    echo "[setup-dev-deps] 错误：esbuild 原生二进制无法执行：${ESBUILD_BIN}" >&2
    echo "[setup-dev-deps] 请把上面的现象与日志发给 lead，不要自行更换方案。" >&2
    exit 1
  fi
  echo "[setup-dev-deps] esbuild 可执行：$( "${ESBUILD_BIN}" --version )"
else
  echo "[setup-dev-deps] 提示：未发现 @esbuild/* 二进制（可能换了构建器），跳过该项自检。"
fi

# ── 5. 输出后续用法 ─────────────────────────────────────────────────────
echo
echo "[setup-dev-deps] 完成。"
echo "  依赖位置：${BUILD_DIR}/node_modules"
echo "  软链位置：${NODE_MODULES_LINK} -> ${BUILD_DIR}/node_modules"
echo "  后续在项目根执行（不要在项目根跑 npm install）："
echo "    npm run dev      # 开发服务，端口 5180"
echo "    npm run build    # 产物落 web/dist"
echo "    npm run preview  # 预览构建产物"
