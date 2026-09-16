# SourceLens Agent Kit

SourceLens Agent Kit provides a ready-to-install, read-only question-answering
integration for Codex and Claude. It combines a CLI, MCP registration, and the
shared `sourcelens-qa` Skill so an agent can select an authorized assistant,
query connected knowledge sources, and return answers with source citations.

## Install

```bash
npx sourcelens-agent-kit install \
  --client codex --url https://lens.example.com/mcp --api-key "$SOURCELENS_API_KEY"
npx sourcelens-agent-kit install --client claude
```

To run an unreleased revision straight from the repository instead:

```bash
npx github:oneprolabs/sourcelens-agent-kit install --client claude
```

The package installs the shared `sourcelens-qa` Skill and a persistent CLI at
`~/.sourcelens/bin/sourcelens`, adds that directory to your shell's `PATH`, writes
`SOURCELENS_MCP_URL` and `SOURCELENS_API_KEY` to `~/.sourcelens/env` (mode 600)
and sources it from your shell profile, then registers the MCP server with
`codex mcp add` and `claude mcp add`. Omit `--url` or `--api-key` to be
prompted; pass `--no-mcp` to install the Skill and CLI without credentials or MCP
configuration. Open a new shell after installation, or use the full CLI path.
Data-source authorization
is still enforced by the gateway.

## Use

The Skill picks an assistant from its routing description, then asks it:

```bash
sourcelens assistants --json
sourcelens ask "Which services depend on the billing queue?" --assistant <slug>
```

`ask` resolves the selector, submits the run, waits for completion, and prints
the answer. Both commands read credentials from the environment or
`~/.sourcelens/env`; both are read-only.
