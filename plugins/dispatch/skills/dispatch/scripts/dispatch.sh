#!/usr/bin/env bash
# dispatch.sh — create a worktree from the default branch and start a coding agent
# in a new Rex window (tab) of the current Rex session.
#
# Usage:
#   dispatch.sh --repo PATH --slug NAME --agent claude|codex --brief FILE [--base BRANCH] [--dry-run]
#
# Env:
#   DISPATCH_CMD   override the agent command (testing); receives the worktree as cwd
set -euo pipefail

die() { echo "dispatch: $*" >&2; exit 1; }

repo="" slug="" agent="claude" brief="" base="" dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo=$2; shift 2 ;;
    --slug) slug=$2; shift 2 ;;
    --agent) agent=$2; shift 2 ;;
    --brief) brief=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$repo" ] && [ -n "$slug" ] && [ -n "$brief" ] || die "need --repo, --slug and --brief"
[ -f "$brief" ] || die "brief file not found: $brief"
case "$agent" in claude|codex) ;; *) die "--agent must be claude or codex" ;; esac
[[ "$slug" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "slug must be lowercase kebab-case: $slug"
command -v rex >/dev/null || die "rex not found"
[ -n "${REX_SESSION:-}" ] || die "not inside a Rex session (REX_SESSION unset)"

repo=$(git -C "$repo" rev-parse --show-toplevel) || die "not a git repo: $repo"
name=$(basename "$repo")

# Default branch: origin/HEAD, else main, else master.
git -C "$repo" fetch --quiet origin || die "git fetch failed"
if [ -z "$base" ]; then
  base=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  if [ -z "$base" ]; then
    for b in main master; do
      git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$b" && { base=$b; break; }
    done
  fi
fi
[ -n "$base" ] || die "could not determine the default branch"

branch="dispatch/$slug"
wt="$(dirname "$repo")/.worktrees/$name/$slug"
[ -e "$wt" ] && die "worktree path already exists: $wt"
git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" && die "branch already exists: $branch"

if [ "$dry" = 1 ]; then
  echo "repo=$repo base=origin/$base branch=$branch worktree=$wt agent=$agent"
  exit 0
fi

mkdir -p "$(dirname "$wt")"
git -C "$repo" worktree add --quiet -b "$branch" "$wt" "origin/$base"
git -C "$wt" branch --quiet --unset-upstream 2>/dev/null || true

# Copy gitignored local config (.env*, .envrc, *.tfvars, secrets yaml, .dev.vars) from the main
# checkout, so the agent can run the stack. Symlinks are kept as symlinks.
copied=()
while IFS= read -r -d '' f; do
  case "$f" in
    */node_modules/*|node_modules/*|*/.next/*|*/dist/*|*/build/*|*/.venv/*|*/.terraform/*) continue ;;
  esac
  b=$(basename "$f")
  case "$b" in
    .env|.env.*|.envrc|*.tfvars|*.tfvars.json|.dev.vars|secrets*.yaml|secrets*.yml|*.local.yaml|*.local.yml|.fizzy.yaml) ;;
    *) continue ;;
  esac
  mkdir -p "$wt/$(dirname "$f")"
  cp -a "$repo/$f" "$wt/$f"
  copied+=("$f")
done < <(git -C "$repo" ls-files -z --others --ignored --exclude-standard)

# Build the agent command line. The brief is passed as the first prompt.
prompt=$(cat "$brief")
if [ -n "${DISPATCH_CMD:-}" ]; then
  cmd=(bash -lc "$DISPATCH_CMD")
elif [ "$agent" = claude ]; then
  # Claude refuses bypass mode as root unless told the host is a sandbox (approved by the user).
  cmd=(env IS_SANDBOX=1 claude --dangerously-skip-permissions
       --settings '{"skipDangerousModePermissionPrompt":true}'
       -n "$slug" "$prompt")
else
  # Codex asks once per repo root whether to trust it; the answer is saved. -c overrides do
  # not satisfy that check, so the skill handles the dialog after launch (see SKILL.md step 5).
  cmd=(codex --dangerously-bypass-approvals-and-sandbox -C "$wt" "$prompt")
fi

# Keep a copy of the brief next to the worktree (outside the tree, so it is never committed).
cp "$brief" "$wt.brief.md"

window_json=$(rex window new -s "$REX_SESSION" "$slug" -c "$wt" --focus=false --keep-open --json -- "${cmd[@]}")

echo "worktree: $wt"
echo "branch:   $branch (from origin/$base)"
echo "agent:    $agent"
echo "brief:    $wt.brief.md"
echo "copied:   ${#copied[@]} ignored config file(s)${copied:+: ${copied[*]}}"
echo "window:   $window_json"
