# pi-sandbox-exec

Minimal macOS sandbox backend for [Pi](https://github.com/earendil-works/pi).

`pi-sandbox-exec` replaces only Pi's agent `bash` execution backend. It does not make permission decisions, filter environment variables, restrict reads, or restrict network access.

## Policy

Agent bash commands run through `/usr/bin/sandbox-exec` with a small Seatbelt profile:

- filesystem read: allowed
- network: allowed
- filesystem write: the workspace captured at session start, the system temporary directory (`os.tmpdir()`), `/tmp`, and `/var/tmp` (canonical paths, including their macOS `/private` aliases)
- process execution/fork: allowed
- process inspection: limited to the sandboxed process itself
- initial working directory: must be inside the captured workspace; commands may `cd` elsewhere, but the same write restrictions still apply

Paths are canonicalized once per session. There are no implicit write grants for `~/.pi/agent`, `~/.codex`, or home dotfiles. Like any other path, they can still be exposed by selecting a workspace or temporary root that contains them. Starting from your home directory or one of its ancestors (including `/`) is rejected. Start Pi in a dedicated project directory instead. Temporary roots that would expose the home directory, nonexistent directories, and paths containing control characters are also rejected.

The profile imports Apple's `bsd.sb` baseline, which grants some system access such as `/dev/null`; this is not a complete filesystem allowlist. Temporary directories are shared with other processes, not private to this session. Reads, credentials in files or environment variables, and network access are not protected by this extension.

This extension is intended to sit behind a separate permission layer. Initialization or execution failures never fall back to unsandboxed bash.

```text
permission extension
        |
      allow
        v
pi-sandbox-exec
        |
/usr/bin/sandbox-exec
        |
     /bin/bash
```

## Install

Clone directly into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/glyzinie/pi-sandbox-exec.git sandbox-exec
```

Then start Pi, or run `/reload` in an existing session.

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`, so no build step or npm install is required.

For a one-off test:

```bash
pi -e ./index.ts
```

## Scope

This extension intentionally does **not** sandbox:

- Pi built-in file tools such as `read`, `write`, and `edit`
- MCP tools
- custom extension code
- user `!` shell commands

It only replaces the agent-facing `bash` tool backend.

## Execution behavior

- Pi's built-in output handling, structured results, renderers, and current-session `PI_*` environment variables are preserved.
- Commands use `/bin/bash -c`. Pi's `shellPath` and `shellCommandPrefix` settings are not inherited by this backend.
- Timeouts must be finite, positive seconds within the Node.js timer limit. Omitting `timeout` imposes no execution deadline.
- Abort, timeout, session replacement, and shutdown terminate active command process groups. Signal exits use the conventional `128 + signal number` status.
- Background commands are not persistent services. After the shell exits, trailing output is drained until idle for 100 ms, for at most one second. Remaining processes in the command's process group are then killed. Use `wait` in the shell when background work belongs to the command. Descendants that create their own process groups are outside this cleanup guarantee.

## Requirements

- macOS with `/usr/bin/sandbox-exec` and Apple's `bsd.sb` profile
- Node.js 22.19 or newer
- Pi exposing `createBashToolDefinition` and `BashOperations`; tested against **0.99.1**

Seatbelt profiles use Apple-private interfaces and may vary between macOS releases. The integration tests exercise the actual OS sandbox rather than only checking generated profile text.

## Development

Bun is used for dependency management and development commands. Installation as a Pi extension still needs no build step or dependency installation.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs TypeScript checking and Node.js's built-in test runner. Use `bun run test`, not `bun test`, to test the supported Node.js host runtime; Bun 1.4.2's `realpathSync` cannot resolve literal backslashes in filenames on macOS. On non-macOS systems, process and Seatbelt integration tests are skipped; macOS CI runs the full suite. Integration tests create disposable fixture directories under the user's home directory so denied targets do not accidentally fall under the allowed `/tmp` tree. They do not modify existing settings or credentials.

```text
index.ts                     Pi registration and session lifecycle
src/paths.ts                 Canonical paths and write policy
src/profile.ts               Seatbelt profile generation
src/operations.ts            Process execution and cleanup
tests/                       Unit and macOS integration tests
```

## License

MIT © 2026 Wis
