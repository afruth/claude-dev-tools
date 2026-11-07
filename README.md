# Claude dev tools

This repository is a Claude Code plugin marketplace. It contains three plugins, `tailscale`, `pr-live-review` and `dispatch`.

## The tailscale plugin

The plugin starts the development stack of the current repository or worktree. It then publishes the stack over HTTPS on your tailnet with `tailscale serve`. It selects host ports that do not conflict with other stacks on the same machine.

The stack is available on your tailnet only. The plugin does not use `tailscale funnel`.

## Requirements

- Claude Code
- Tailscale, connected to a tailnet that has MagicDNS and HTTPS on
- Node.js and git
- `agent-browser`, for the browser test step

## Install

```
claude plugin marketplace add afruth/claude-dev-tools
claude plugin install tailscale@dev-tools
claude plugin install pr-live-review@dev-tools
claude plugin install dispatch@dev-tools
```

## Use

| Command | Result |
| - | - |
| `/tailscale:tailscale` or `/tailscale:tailscale up` | Starts the stack, publishes it, and tests it. |
| `/tailscale:tailscale down` | Removes the proxies of this checkout, stops its stack, and restores its env values. |
| `/tailscale:tailscale status` | Shows the proxies of this checkout and all other serve entries on the machine. |

## The pr-live-review plugin

The plugin opens a pane with the diff of the checked-out PR against its base branch. It shows a summary for each file. You can add comments to lines and send all comments to Claude as one prompt. The source is in the [afruth/pr-live-review](https://github.com/afruth/pr-live-review) repository.

| Command | Result |
| - | - |
| `/pr-live-review [repo path]` | Opens the review pane for the PR of the current checkout or of the given path. |

## The dispatch plugin

The plugin hands a task to a separate coding agent. It creates a git worktree from the default branch of the repository, copies the gitignored local config files (`.env*`, `.envrc`, `*.tfvars`, local secrets YAML) into it, and opens a new Rex window in the current Rex session. In that window it starts Claude Code or Codex with all permission prompts off and a brief that tells the agent to implement, test, commit, push and open a pull request.

| Command | Result |
| - | - |
| `/dispatch:dispatch <task>` | Writes a brief for the task and starts Claude Code on it in a new worktree and Rex window. |
| `/dispatch:dispatch codex <task>` | The same with Codex. |

Requirements: Rex (run Claude Code inside a Rex session), git, `gh`, and Claude Code or Codex. As root, Claude Code is started with `IS_SANDBOX=1` so that it accepts `--dangerously-skip-permissions`. The first dispatch to a repository asks once whether to trust the folder.

## Update

```
claude plugin marketplace update dev-tools
claude plugin update tailscale@dev-tools
claude plugin update pr-live-review@dev-tools
claude plugin update dispatch@dev-tools
```

## Limits

The tailscale plugin was tested on macOS only. The dispatch plugin was tested on Linux only. Examine the skill text before you use it, because it starts and stops processes on your machine.
