# Claude dev tools

This repository is a Claude Code plugin marketplace. It contains two plugins, `tailscale` and `pr-live-review`.

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

## Update

```
claude plugin marketplace update dev-tools
claude plugin update tailscale@dev-tools
claude plugin update pr-live-review@dev-tools
```

## Limits

The plugin was tested on macOS only. Examine the skill text before you use it, because it starts and stops processes on your machine.
