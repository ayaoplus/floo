#!/bin/bash
# Floo 人工提交编译门禁：pre-commit hook
# 非 floo tmux session 下的手动 commit 会跑 tsc --noEmit，失败则拒绝 commit
#
# 为什么只在非 floo session 生效？
# - floo session 内由 post-commit 负责（commit 后 soft reset，兼容 agent 的 commit wrapper）
# - pre-commit 拒绝会打断 agent 的 commit-wrapper 流程，引入不稳定
#
# 安装方式：floo init 自动复制到 .git/hooks/pre-commit
# 卸载方式：删除 .git/hooks/pre-commit
# 临时绕过：git commit --no-verify
# 标记：FLOO_PRE_COMMIT_HOOK

# 在 floo tmux session 内则跳过（交给 post-commit 处理）
if [ -n "$TMUX" ]; then
  SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
  if echo "$SESSION_NAME" | grep -q '^floo-'; then
    exit 0
  fi
fi

# 非 TypeScript 项目：跳过
if [ ! -f tsconfig.json ]; then
  exit 0
fi

# 没有 npx 命令（Node 没装）：跳过，不拦住 commit
if ! command -v npx >/dev/null 2>&1; then
  exit 0
fi

echo "[floo] 跑 tsc --noEmit 验证 TypeScript 编译..."
if ! npx --no-install tsc --noEmit 2>&1; then
  echo ""
  echo "[floo] ✗ tsc 编译失败，commit 被拒绝"
  echo "[floo]   修复 type error 后再提交，或用 git commit --no-verify 跳过检查"
  exit 1
fi

echo "[floo] ✓ tsc 通过"
exit 0
