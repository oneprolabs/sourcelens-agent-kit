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
sourcelens ask "Generate a report" --assistant <slug|uuid|name> --download-dir ./artifacts --json
sourcelens download <run-uuid> --download-dir ./artifacts --json
```

`ping` checks the service URL and credentials without spending a run. `ask`
resolves the selector, creates a session and run, waits for completion, and
prints the answer. Both commands read credentials from the environment or
`~/.config/sourcelens/env`; all three are read-only.

Published deliverables appear in `output_files` in JSON and under `Files:` in
text output. With `--download-dir`, the CLI streams files to
`<directory>/<run-uuid>/<filename>` and adds `local_path` and
`download_status: "downloaded"` to each saved attachment. Duplicate filenames
within a response receive a file UUID prefix and, if needed, a numeric prefix.
Case and Unicode equivalent names are also treated as duplicates. Long names are
shortened to fit the local filename limit while retaining their extension.
Local paths are absolute so an
agent can open the files directly with its file or document tools.

`download` fetches an existing completed run and its files without starting
another question. Both commands use the configured Bearer credential; downloads
require the server to expose `output_files` on runs and allow agent credentials
to access the private output-file endpoint. If that field is missing, `download`
reports that the server needs an update instead of treating it as an empty list.

Existing local files are never overwritten. Failed downloads leave no partial
file, retain the answer and attachment metadata, add `download_status: "failed"`
and `download_error`, and exit with code 1. Successful files from the same batch
remain available. Retry into a fresh directory with `download`. `--timeout S`
bounds each file download separately (default: 180 seconds), in addition to the
question's result wait. URLs must use the configured service origin; redirects
are refused. The CLI downloads files but does not execute them.
