# SourceLens Agent Kit: Q&A package

This package gives Codex and Claude a read-only question-answering interface
to a SourceLens deployment. It contains the shared Skill instructions and the
`sourcelens` CLI the Skill drives; the CLI talks to the SourceLens REST API
directly, and data-source enforcement stays on the server.

## Usage

```bash
sourcelens ping                         # service URL + credentials, no Q&A run
sourcelens assistants --json            # routing catalog: uuid, capability, datasources, routing_description
sourcelens ask "<question>" --assistant <slug|uuid|name>
```

`ping` is the lightweight check that the service URL, credentials, and scope
work; `assistants` lists every assistant visible to the account. The agent reads
the `routing_description` of each candidate, picks the best match — asking the
user to choose when none clearly fits — and then runs `ask`, which creates a
session and run, waits for completion, and prints the answer.
`--json` returns the raw run payload (`uuid`, `status`, `answer`, `citations`)
so the agent can shape the final reply itself.

## Configuration

The installer asks for the service base URL and API key, then writes them to
`~/.config/sourcelens/env` (mode 600) and sources that file from your shell
profile:

```bash
SOURCELENS_BASE_URL=<service base url>
SOURCELENS_API_KEY=<api key>
```

Point `SOURCELENS_BASE_URL` at the SourceLens root, for example
`https://lens.example.com` (not a sub-path). The server rejects requests whose
key is not authorized for the target workspaces; never commit the credentials
file.

## Installation

```bash
npx sourcelens-agent-kit install --url https://lens.example.com
```

The Skill is installed for both Codex and Claude. When `--url` or `--api-key`
is omitted the installer prompts for it (the API key prompt hides input);
`SOURCELENS_BASE_URL` and `SOURCELENS_API_KEY` are also read from the
environment.

The CLI is persisted at `~/.local/bin/sourcelens` and added to the shell
profile's `PATH`. Open a new shell or use that full path immediately. Paths
follow the XDG base directory spec (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_BIN_HOME`); `SOURCELENS_CONFIG_HOME`, `SOURCELENS_DATA_HOME`, and
`SOURCELENS_BIN_HOME` override them individually. Installations created before
the XDG split (credentials in `~/.sourcelens/env`) are migrated on the next
install, and `SOURCELENS_HOME` still selects the legacy single-directory layout.

Pass `--no-auth` to install the Skill and CLI without configuring credentials.
Existing credentials are preserved.
