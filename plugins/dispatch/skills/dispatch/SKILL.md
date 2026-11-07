---
name: dispatch
description: Hand a task off to a separate coding agent that works on its own. Creates a fresh git worktree from the repo's default branch on this server, opens a new Rex window (tab) in the current Rex session on that worktree, and starts Claude Code or Codex in bypass/yolo mode with a full brief so it implements the request end to end (code, tests, checks, commit, push, pull request). Use when the user runs /dispatch, or says "dispatch this", "hand this off to an agent", "spin up a claude/codex on this", "start an agent in a new tab/worktree".
---

# Dispatch

Hand the user's request to an independent agent running in its own worktree and Rex tab.
Your job is to pick the repo and agent, write a strong brief, launch it, and report back.
You do **not** implement the task yourself.

## 1. Settle the inputs

- **Repo**: the git repo the work belongs in. Default to the repo of the current working
  directory. If the cwd is not a repo, or the request names a project, find it under
  this machine's projects folder (`~/development/<org>/<repo>` on Linux servers,
  `~/Documents/Development/...` on the Macs). Ask only if it is genuinely ambiguous.
- **Agent**: `claude` unless the user says codex. "yolo" is implied for both.
- **Slug**: short kebab-case name for the task (`fix-invoice-rounding`). It becomes the
  branch `dispatch/<slug>`, the worktree folder and the tab label.
- **Base**: the remote default branch (usually `main`), unless the user names another.

Several independent tasks in one request: dispatch one agent per task, each with its own slug.

## 2. Gather just enough context for the brief

Spend a few tool calls, not a full investigation: read the repo's `CLAUDE.md` / `AGENTS.md`
/ `README`, its package manager and test/lint/typecheck commands, and the files the
request obviously touches. Include what you learned in the conversation (decisions the
user made, constraints, error output, screenshots described in words). The agent gets
nothing but the brief.

## 3. Write the brief

Write it to the scratchpad directory as `dispatch-<slug>.md`. Structure:

```markdown
# Task: <one-line goal>

## What the user wants
<The request in full, in the user's words where possible, plus every decision and
constraint from the conversation. Concrete acceptance criteria as a checklist.>

## Context
<Repo, relevant files and how they fit, commands for install/dev/test/lint/typecheck,
conventions from CLAUDE.md/AGENTS.md, anything already ruled out.>

## Environment
- You are in a git worktree at <path>, on branch `dispatch/<slug>` created from `origin/<base>`.
  The main checkout at <repo path> is someone else's; do not touch it.
- Gitignored local config (.env files etc.) was copied from the main checkout.
- If you start a dev stack, pick ports that do not collide with other stacks on this
  machine (check with `ss -ltn`), or use the `/tailscale` skill if you are Claude.
- You are running with all permission prompts disabled. Stay inside this worktree; no
  destructive actions on shared resources (prod databases, cloud infra, other branches).

## How to work — end to end, no check-ins
1. Read the code and plan briefly. Do not stop to ask questions; make reasonable
   decisions and record them in the PR description. Only stop if truly blocked
   (missing credentials, contradictory requirements) and say exactly what you need.
2. Implement the change fully, following existing patterns.
3. Add or update tests. Run the test suite, linter and typechecker; fix what fails.
4. Verify the behavior for real where possible (run the app, hit the endpoint, run the CLI).
5. Commit in logical commits with clear messages, ending with the attribution line:
   `Co-Authored-By: <your model name> <noreply@anthropic.com or your vendor's>`.
6. `git push -u origin dispatch/<slug>` and open a pull request against `<base>` with
   `gh pr create`: summary, decisions made, how it was tested, anything left open.
7. Finish with a short final message: PR link, what was done, what was not verified.
```

Adapt the steps if the user asked for something different (no PR, draft PR, don't push,
research only). Codex: drop the `/tailscale` mention and the Claude attribution wording.

## 4. Launch

Must run inside a Rex session (`$REX_SESSION` set). Run:

```bash
"${CLAUDE_SKILL_DIR}/scripts/dispatch.sh" --repo <repo> --slug <slug> --agent <claude|codex> \
  --brief <scratchpad>/dispatch-<slug>.md [--base <branch>]
```

The script fetches origin, creates `<repo-parent>/.worktrees/<repo>/<slug>` on branch
`dispatch/<slug>`, copies gitignored config files (`.env*`, `.envrc`, `*.tfvars`, local
secrets yaml), saves the brief as `<worktree>.brief.md`, and opens a background Rex tab
labeled `<slug>` running:

- claude: `IS_SANDBOX=1 claude --dangerously-skip-permissions -n <slug> "<brief>"`
- codex: `codex --dangerously-bypass-approvals-and-sandbox -C <worktree> "<brief>"`

The tab stays open after the agent exits. `--dry-run` prints the plan without creating anything.

## 5. Confirm it started, then report

After ~10 seconds, check the agent is working, not stuck on a prompt:
`rex capture -s "$REX_SESSION" -w <slug> | tail -30`. If it waits on a dialog (trust,
login, update), resolve it with `rex send-key` / `rex send` or tell the user.

Known dialogs:
- **Codex "Trust this folder?"**: appears once per repo root (trust is saved for the main
  repo and covers its worktrees). Ask the user before accepting it for a repo for the first time.
- **Claude "Is this a project you created or one you trust?"**: also once per repo; after
  it is accepted, later worktrees of that repo start without it. Same rule: ask the user
  before accepting it for a repo for the first time (it's "down" then "enter" via `rex send-key`).
- **Claude as root**: the script sets `IS_SANDBOX=1` (approved by the user) so bypass mode
  starts as root. If Claude still refuses, tell the user.

Report to the user in a few lines: tab name, agent, worktree path, branch, and that the
agent will open a PR when done. Mention they can watch with `rex focus` on the tab.

## Cleanup (when the user asks)

`git -C <repo> worktree remove <worktree>` and `git -C <repo> branch -D dispatch/<slug>`
after the PR is merged or abandoned; `rm <worktree>.brief.md`.
