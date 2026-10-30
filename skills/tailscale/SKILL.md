---
name: tailscale
description: Start the development stack of the current repository or worktree and publish it over HTTPS on the tailnet with `tailscale serve`, with host ports that do not conflict with other stacks on this machine. Also shows the status and shuts the stack and its proxies down. Use when the user runs /tailscale, or asks to open a dev stack from another device, to get a Tailscale or ts.net URL for the stack, or to take a Tailscale serve down. Works for any repository.
argument-hint: '[up|down|status]'
---

# Tailscale dev stack

This skill publishes the development stack of the current checkout on the tailnet. Each checkout is one repository clone or one worktree.

The argument selects the operation. No argument means `up`.

| Argument | Operation |
| - | - |
| `up` | Start the stack, publish it, and test it. |
| `down` | Remove the proxies of this checkout, stop its stack, and restore its env values. |
| `status` | Show the proxies of this checkout and all other serve entries on this machine. |

## Safety rules

- Do not use `tailscale funnel`. Funnel publishes to the internet. This skill publishes to the tailnet only.
- Do not use `tailscale serve reset`. It removes the proxies of all other stacks.
- Do not remove a serve entry that this checkout does not own. Use `tsdev.mjs` for all serve changes.
- Do not delete volumes or data. Do not use `docker compose down -v` in a stop command.
- Do not change tracked files without approval from the user. Use untracked env files.
- Do not start, stop, or edit a stack of another checkout.
- Do not use a port, a database, or a Compose project name of the main worktree in a linked worktree.
- Do not show the values from env files in chat. Report key names only.

## The helper script

Run all helper commands from the root of the checkout.

```
node "${CLAUDE_SKILL_DIR}/scripts/tsdev.mjs" <command>
```

| Command | Result |
| - | - |
| `reserve --count N --from P` | Finds a block of free host ports. The search includes listening ports, Docker ports, and serve ports. |
| `record --stop "<command>"` | Records the command that stops the stack. |
| `set-env <file> KEY=VALUE ...` | Changes an untracked env file and records the original values. |
| `serve name=hostPort ...` | Adds HTTPS proxies and records them. It uses the host port plus 10000 as the HTTPS port when that port is free. |
| `check` | Sends a request to each URL of this checkout. |
| `status` | Prints the record of this checkout and all other serve entries. |
| `down [--dry-run]` | Removes the owned proxies, runs the stop command, and restores env values. |
| `release <httpsPort>` | Removes an entry that has no owner. It refuses if the target port still listens. |

The record is `tsdev.json` in the git folder of the checkout, so git never commits it. Each worktree has its own record.

## Procedure for `up`

1. Run `status`. Stop if the script reports that Tailscale is not connected, or that MagicDNS or HTTPS is off, and tell the user the fix.
2. If this checkout has active proxies and the targets listen, run `check`. If all URLs respond, report them and stop.
3. If this checkout is a linked worktree, make sure that it has the env files. Git ignores these files, so a new worktree does not have them.
   1. If the repository has a setup tool that copies env values, use that tool in step 6 and go to step 4.
   2. Find the main worktree. It is the first `worktree` line of `git worktree list --porcelain`.
   3. List its env files: `git -C <main> ls-files --others --ignored --exclude-standard --directory | grep -E '(^|/)\.env|\.env$'`.
   4. Copy each missing file to the same path in this checkout. Do not overwrite a file. In an existing file, add only the missing or empty secrets.
   5. Edit the values that belong to the main worktree: `COMPOSE_PROJECT_NAME`, ports, URLs, and database hosts. Step 6 and step 8 give the correct values. If you keep them, `docker compose down` in this checkout can stop the main stack.
   6. If the stack later fails because a different local file is missing, look for that file in the main worktree. Copy only what the stack needs.
4. Identify the stack. Read these sources in this order, and stop when you know the start command:
   1. `CLAUDE.md`, `AGENTS.md`, and `README*`
   2. `Makefile`, `justfile`, and `Taskfile*`
   3. `docker-compose*.yml` and `compose*.yml`
   4. `package.json` scripts, `Procfile`, `pyproject.toml`, `manage.py`, `Cargo.toml`, `go.mod`, `Gemfile`, and `mix.exs`
5. Find the browser-facing services: the frontend, the API, file storage, and any admin console. Do not publish databases, Redis, or debug ports.
6. Assign host ports. Use the first method that the repository supports:
   1. Run the setup tool of the repository, if it has one. Give it a free base port from `reserve`.
   2. Edit the port variables directly in the untracked env file. Do not use `set-env` for ports, because `down` restores `set-env` values, and the ports must stay separate from the main worktree.
   3. For Compose, set `COMPOSE_PROJECT_NAME` to a name that is unique to the checkout, so that containers and volumes stay separate.
   4. For a native dev server, give the port as an env value or as a flag.
   5. If the ports are hardcoded, stop and ask the user. Do not change tracked files without approval.
7. Install the dependencies if the checkout has none. Use the lockfile command, for example `npm ci`.
8. Read `machine.host` from the `status` output of step 1. Calculate each public URL as `https://<machine.host>:<hostPort + 10000>`. Use `set-env` to set these values before the first start:
   - The API URL that the browser uses, for example `VITE_API_URL` or `NEXT_PUBLIC_API_URL`.
   - The CORS origin and any allowed origins.
   - The public URL of the app, for example `APP_URL`, used in emails and redirects.
   - The public endpoint for file storage, used for presigned URLs.
   - The cookie domain, if the project sets one.
   - The allowed hosts of the dev server. See the framework notes.
9. Start the stack in detached mode. Do not use a target that follows logs, because that command never exits. For example, read the Makefile target and run its `up -d` line.
10. For a native dev server, start it with `nohup`, write its process ID to a file in the scratchpad, and use `kill <pid>` as the stop command.
11. Record the stop command with `record --stop`, immediately after the start. If the start fails because a port is in use, run `reserve` with a higher `--from` value, and go back to step 6. A stopped stack of another checkout does not hold its ports, so this clash can occur.
12. Wait for the health endpoint of the service. Read the real route from the code. A 404 from a running server means that the route is wrong, not that the server is down.
13. Run `serve name=hostPort ...` for each browser-facing service.
14. If `serve` chose an HTTPS port that is not the calculated port, correct the values from step 8 with `set-env`.
15. Recreate the containers or restart the server if any env value changed after the start. A plain `docker compose restart` does not read env files again. Use `docker compose up -d --no-deps --force-recreate <services>`.
16. Run `check`. It requests the root path, so any HTTP status shows that the proxy and the service respond. A 404 from an API or a 403 from file storage is normal. A "no response" result or a 502 is a failure.
17. Open the frontend URL in a real browser with `agent-browser`. Look for page errors, CORS errors, and a blocked host message. Do this test even when `check` passes.

## Framework notes

- **Vite 6:** The dev server blocks unknown host names. It accepts `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` from the process environment, so put it in the env file of the container. For other versions, read the version first and use `server.allowedHosts` with approval from the user.
- **Next.js:** Add the host name to `allowedDevOrigins`.
- **Django:** Add the host name to `ALLOWED_HOSTS` and the origin to `CSRF_TRUSTED_ORIGINS`.
- **Rails:** Add the host name to `config.hosts`.
- **Bind mounts:** A bind mount of a package folder hides the `node_modules` folder of the image. If a module is missing in the container, install the dependencies on the host and then restart the container.
- **One origin:** After this procedure, CORS usually accepts only the HTTPS frontend URL. Requests from `localhost` can fail until you run `down`.

## Procedure for `down`

1. Run `down --dry-run`. Examine the proxies, the stop command, and the env values.
2. If the output says that no record exists, run `status`. Look for entries in `otherServeEntries` that target the ports of this checkout. Show these entries to the user and ask before you continue.
3. Run `down`.
4. Run `status` to make sure that the proxies are gone and that the other entries did not change.
5. Report the removed proxies, the stopped stack, and the restored env values.

## Procedure for `status`

Run `status`. Report the URLs of this checkout and whether each target listens. Also report the entries in `otherServeEntries` that have no listening target, because their stack is gone. Remove such an entry with `release` only if the user asks.

## The final report for `up`

Give a table with the service, the HTTPS URL, and the test result. Then state:

- Which tests you did not do, for example a sign-in or a file upload.
- Which env values you changed.
- That a repository setup tool can write its own URLs again if the user runs it.
- That the serve entries stay active after a reboot, until you run `/tailscale down`.

## Example: a repository with a setup tool

A repository with `tools/dev/setup-worktree.mjs` and a Compose stack uses this order:

1. `reserve --count 10 --from 3300` gives a free block, for example 3310.
2. `node tools/dev/setup-worktree.mjs --force-ports --base-port=3310` writes the ports and `localhost` URLs.
3. `set-env` then changes the URL keys to the HTTPS URLs. Do this step after the setup tool, because the tool writes its own URL values.
4. `docker compose up --build -d` starts the stack, and `record --stop "docker compose down"` records the stop command.
