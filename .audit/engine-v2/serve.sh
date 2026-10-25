#!/bin/bash
# bun server for the a-better-me-v2 worktree: serve.sh [pageSize] [retentionMs] [compactEveryMs]; run it in the background
cd /Users/stefan/code/a-better-me-v2/server || exit 1
[ -n "$1" ] && export SYNC_PAGE_SIZE="$1"
[ -n "$2" ] && export SYNC_RETENTION_MS="$2"
[ -n "$3" ] && export SYNC_COMPACT_EVERY_MS="$3"
echo "$(date -u +%FT%T.%3NZ) serve.sh pageSize=${1:-default} retention=${2:-default} compactEvery=${3:-default}"
exec bun src/index.ts
