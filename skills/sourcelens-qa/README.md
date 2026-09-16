# SourceLens Agent Kit: Q&A package

This package gives Codex and Claude a read-only question-answering interface
to a SourceLens deployment. It contains shared Skill instructions, a
client-neutral MCP descriptor, and the `sourcelens` CLI the Skill drives;
data-source enforcement remains in the SourceLens MCP gateway.

## Usage

```bash
sourcelens assistants --json            # routing catalog: uuid, capability, datasources, routing_description
sourcelens ask "<question>" --assistant <slug|uuid|name>
```

`assistants` lists every assistant visible to the account. The agent reads the
`routing_description` of each candidate, picks the best match, and then runs
`ask`, which submits the run, waits for completion, and prints the answer.
`--json` returns the raw run payload (`run_uuid`, `status`, `answer`,
`citations`) so the agent can shape the final reply itself.

## Configuration

The installer asks for the gateway URL and API key, then writes them to
`~/.sourcelens/env` (mode 600) and sources that file from your shell profile:

```bash
SOURCELENS_MCP_URL=<gateway url>
SOURCELENS_API_KEY=<api key>
```

`mcp.json` declares `url_env` and `api_key_env`, so host clients read the same
variables. Point `SOURCELENS_MCP_URL` at the MCP endpoint supplied by your
administrator. The gateway rejects requests whose key is not authorized for
the target workspaces; never commit the credentials file.

## Installation

```bash
npx github:oneprolabs/sourcelens-agent-kit install \
  --client codex --url https://lens.example.com/mcp --api-key "$SOURCELENS_API_KEY"
npx github:oneprolabs/sourcelens-agent-kit install --client claude
```

Use `all` to install both clients. When `--url` or `--api-key` is omitted the
installer prompts for it.

The installer also registers the MCP server with each host CLI:

- Codex — `codex mcp add sourcelens-qa --url <gateway> --bearer-token-env-var
  SOURCELENS_API_KEY`, so Codex reads the token from the environment at launch.
- Claude — `claude mcp add sourcelens-qa --scope user --transport http <gateway>
  -H "Authorization: Bearer <token>"`, which stores the token in
  `~/.claude.json` (mode 600).

The CLI is persisted at `~/.sourcelens/bin/sourcelens` and added to the shell
profile's `PATH`. Open a new shell or use that full path immediately.
`SOURCELENS_HOME` overrides the `~/.sourcelens` directory.

Pass `--no-mcp` to install the Skill and CLI without configuring credentials
or MCP. Existing credentials are preserved. Registration is skipped when the
host CLI is not on `PATH`; the installer then prints the manual command.
