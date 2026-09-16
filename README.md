# SourceLens Agent Kit

SourceLens Agent Kit gives Codex and Claude a read-only question-answering
interface to a SourceLens deployment. It bundles the `sourcelens-qa` Skill and
a `sourcelens` CLI so an agent can select an authorized assistant, query
connected knowledge sources, and answer with source citations.

## Install

Requires Node.js 18 or newer.

```bash
npx sourcelens-agent-kit install --url https://lens.example.com
```

The package installs the shared `sourcelens-qa` Skill for both Codex and Claude,
plus a persistent CLI at `~/.local/bin/sourcelens`. It adds that directory to
your shell's `PATH`, writes `SOURCELENS_BASE_URL` and `SOURCELENS_API_KEY` to
`~/.config/sourcelens/env` (mode 600) and sources it from your shell profile.
Paths follow the XDG base directory spec (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_BIN_HOME`); `SOURCELENS_CONFIG_HOME`, `SOURCELENS_DATA_HOME`, and
`SOURCELENS_BIN_HOME` override them individually.

Point `--url` at the SourceLens root (for example `https://lens.example.com`).
Omit `--url` or `--api-key` to be prompted (the API key prompt hides input);
`SOURCELENS_BASE_URL` and `SOURCELENS_API_KEY` are also read from the
environment. Pass `--no-auth` to install the Skill and CLI without credentials.
Open a new shell after installation, or use the full CLI path. Data-source
authorization is still enforced by the server.

## Use

The Skill picks an assistant from its routing description, then asks it:

```bash
sourcelens ping
sourcelens assistants --json
sourcelens ask "Which services depend on the billing queue?" --assistant <slug|uuid|name>
```

`ping` checks the service URL and credentials without spending a run. `ask`
resolves the selector, creates a session and run, waits for completion, and
prints the answer. Both commands read credentials from the environment or
`~/.config/sourcelens/env`; all three are read-only.
