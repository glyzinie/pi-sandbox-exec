# pi-sandbox-exec

Minimal macOS sandbox backend for [Pi](https://github.com/earendil-works/pi).

`pi-sandbox-exec` replaces only Pi's agent `bash` execution backend. It does not make permission decisions, filter environment variables, restrict reads, or restrict network access.

## Policy

Agent bash commands run through `/usr/bin/sandbox-exec` with a small Seatbelt profile:

- filesystem read: allowed
- network: allowed
- filesystem write: workspace and temporary directories only
- process execution/fork: allowed
- process inspection: limited to the sandboxed process itself
- working directory: must remain inside the workspace captured at session start

This extension is intended to sit behind a separate permission layer.

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

## Requirements

- macOS
- Pi with `BashOperations` support
- `/usr/bin/sandbox-exec`

## License

MIT © 2026 Wis
