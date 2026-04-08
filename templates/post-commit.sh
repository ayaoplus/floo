#!/bin/bash
# Floo 编译门禁：post-commit hook
# agent commit 后自动跑 tsc --noEmit，编译失败则 soft reset 让 agent 继续修
#
# 安装方式：floo init 自动复制到 .git/hooks/post-commit
# 卸载方式：删除 .git/hooks/post-commit
# 标记：FLOO_POST_COMMIT_HOOK

# 只在 floo tmux session 内生效，不影响用户手动 commit
if [ -z "$TMUX" ]; then
  exit 0
fi
SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
if ! echo "$SESSION_NAME" | grep -q '^floo-'; then
  exit 0
fi

# 检查是否有 TypeScript 项目（tsconfig.json 存在）
if [ ! -f tsconfig.json ]; then
  exit 0
fi

# 检查 npx 是否可用
if ! command -v npx >/dev/null 2>&1; then
  exit 0
fi

# 运行 tsc --noEmit 检查编译错误
if ! npx tsc --noEmit 2>&1; then
  echo ""
  echo "[floo] tsc 编译失败，撤销 commit（代码保留在 working tree）"
  # 用 $FLOO_REAL_GIT 绕过 git wrapper 的写锁，避免死锁
  # （post-commit 在外层 git commit 的锁内运行，wrapper 会重入同一把锁）
  _GIT="${FLOO_REAL_GIT:-git}"
  "$_GIT" reset --soft HEAD~1
  exit 1
fi
