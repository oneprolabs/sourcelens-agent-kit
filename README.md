# SourceLens Agent Kit

SourceLens Agent Kit gives Codex and Claude a read-only question-answering
interface to a SourceLens deployment. It bundles the `sourcelens-qa` Skill, MCP
registration, and a `sourcelens` CLI so an agent can select an authorized
assistant, query connected knowledge sources, and answer with source citations.

## Install

Requires Node.js 18 or newer.

```bash
npx sourcelens-agent-kit install --url https://lens.example.com/mcp
```

The package installs the shared `sourcelens-qa` Skill for both Codex and Claude,
plus a persistent CLI at `~/.local/bin/sourcelens`. It adds that directory to
your shell's `PATH`, writes `SOURCELENS_MCP_URL` and `SOURCELENS_API_KEY` to
`~/.config/sourcelens/env` (mode 600) and sources it from your shell profile,
then registers the MCP server with `codex mcp add` and `claude mcp add` when
those CLIs are on `PATH`. Paths follow the XDG base directory spec
(`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_BIN_HOME`); `SOURCELENS_CONFIG_HOME`,
`SOURCELENS_DATA_HOME`, and `SOURCELENS_BIN_HOME` override them individually.

Omit `--url` or `--api-key` to be prompted (the API key prompt hides input);
`SOURCELENS_MCP_URL` and `SOURCELENS_API_KEY` are also read from the
environment. Pass `--no-mcp` to install the Skill and CLI without credentials or
MCP configuration. Open a new shell after installation, or use the full CLI
path. Data-source authorization is still enforced by the gateway.

## Use

The Skill picks an assistant from its routing description, then asks it:

```bash
sourcelens ping
sourcelens assistants --json
sourcelens ask "Which services depend on the billing queue?" --assistant <slug|uuid|name>
```

`ping` checks the MCP endpoint and its read-only tools without spending a run.
`ask` resolves the selector, submits the run, waits for completion, and prints
the answer. Both commands read credentials from the environment or
`~/.config/sourcelens/env`; all three are read-only.
