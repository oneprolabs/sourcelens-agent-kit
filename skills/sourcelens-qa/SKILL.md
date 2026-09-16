---
name: sourcelens-qa
description: Answer questions that depend on documents, code repositories, project records, or other connected knowledge sources by choosing an authorized SourceLens assistant and citing the returned evidence.
---

# SourceLens Q&A

Use SourceLens for questions whose answer must come from the user's connected
knowledge sources. You choose the assistant yourself — asking the user only
when no candidate clearly fits — then shape the answer before returning it.

## Workflow

If `sourcelens` is not on `PATH` yet, invoke
`"$HOME/.local/bin/sourcelens"` in the commands below.

1. **Discover the assistants.**

   ```bash
   sourcelens assistants --json
   ```

   Each entry carries `uuid`, `slug`, `name`, `capability`, `mode`,
   `datasources`, and `routing_description`. The routing synopsis states the
   assistant's capability, the requests it suits, its Skills, its MCPs, and
   whether its workspace scope is limited to configured directories.

2. **Choose exactly one assistant.** Read every `routing_description` and
   weigh it together with `datasources`, `capability`, and `mode`. Pick the
   single best match for the user's question. An assistant is always required,
   so a selection is always necessary.

   - `capability: knowledge_qa` answers over its bound data sources.
     `capability: general_chat` additionally covers connected tools.
   - `mode: direct` answers from that assistant alone. `mode: smart` routes
     across a collaboration team and suits broad or multi-topic questions.
   - A data source name on its own is weak evidence; match on the routing
     synopsis first.

   When no candidate clearly fits, or several are genuinely tied, do not guess:
   show the user a short list of the plausible assistants — `name` plus a
   one-line `routing_description`, with `capability` and `datasources` when they
   disambiguate — and ask which one to use. When nothing looks close, offer the
   whole catalog the same way. Pass `--lang` so the list matches the user's
   language, then continue with the assistant the user picks.

3. **Ask.**

   ```bash
   sourcelens ask "<question>" --assistant <slug|uuid|name>
   ```

   Useful options: `--timeout S` to bound the wait, `--json` for the raw run
   payload (`uuid`, `status`, `answer`, `citations`), `--lang zh|en|es` to
   localize the routing text and the answer. The command resolves the selector,
   creates a session and run, waits for completion, and prints the answer.

   The request is read-only.

4. **Finish the answer locally.** SourceLens returns evidence, not a finished
   reply. Before responding to the user:

   - Answer in the user's own language.
   - Cite the sources that came back. Each citation carries a `path` relative
     to the mounted data source (`<mount name>/<relative path>`), a
     `start_line`/`end_line` window, and a `supports` note. Cite them as
     `path:start_line-end_line`.
   - When `citations` is empty, say the answer is uncited instead of inventing
     references.
   - Separate what the assistant returned from your own reading of it.
   - Report `status != done`, timeouts, and incomplete or conflicting evidence
     plainly rather than filling the gaps.

5. **Stay read-only.** Do not create, update, delete, configure, or administer
   workspaces, assistants, connections, or data sources.

## Credentials

`sourcelens assistants` and `sourcelens ask` read `SOURCELENS_BASE_URL` and
`SOURCELENS_API_KEY` from the environment, falling back to
`~/.config/sourcelens/env` when the shell profile has not loaded them. Run
`sourcelens install --url <service url> --api-key <key>` when they are missing
or expired. Run `sourcelens ping` to confirm the service URL and credentials
respond; it spends no run and is safe to run before every session.
