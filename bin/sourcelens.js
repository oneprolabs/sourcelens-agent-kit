#!/usr/bin/env node

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const POLL_INTERVAL_MS = 1500
const DEFAULT_TIMEOUT_S = 180
const TOOLS = ['sourcelens_ask', 'sourcelens_search']

function die(message, code = 2) {
  console.error(message)
  process.exit(code)
}

function usage() {
  console.error(`Usage: sourcelens <command> [options]

Commands:
  install [--client codex|claude|all] [--url URL] [--api-key KEY] [--no-mcp]
        Install the SourceLens Q&A skill, store credentials, and register the
        MCP server with the host CLI. Pass --no-mcp to skip credentials and MCP setup.

  assistants [--json] [--lang zh|en|es]
        List assistants with the routing synopsis used to choose one.

  ask "<question>" --assistant <slug|uuid|name> [--tool sourcelens_ask|sourcelens_search]
        [--workspace NAME] [--max-results N] [--timeout S] [--json] [--lang zh|en|es]
        Ask one assistant and wait for the answer.

Credentials come from SOURCELENS_MCP_URL and SOURCELENS_API_KEY, or from
~/.sourcelens/env written by 'sourcelens install'.`)
}

function parseArgs(argv, spec) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      options._.push(arg)
      continue
    }
    const name = arg.slice(2)
    const kind = spec[name]
    if (!kind) die(`unknown option --${name}`)
    if (kind === 'bool') {
      options[name] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) die(`--${name} requires a value`)
    options[name] = value
    i += 1
  }
  return options
}

function envFilePath() {
  const home = process.env.SOURCELENS_HOME || path.join(os.homedir(), '.sourcelens')
  return path.join(home, 'env')
}

function readEnvFile() {
  const file = envFilePath()
  if (!fs.existsSync(file)) return {}
  const script =
    'set -a; . "$1" 2>/dev/null; set +a; ' +
    'printf "%s\\0%s\\0" "${SOURCELENS_MCP_URL:-}" "${SOURCELENS_API_KEY:-}"'
  const result = spawnSync('bash', ['-c', script, 'sourcelens', file], { encoding: 'utf8' })
  if (result.status !== 0) return {}
  const [url, key] = result.stdout.split('\0')
  return { SOURCELENS_MCP_URL: url, SOURCELENS_API_KEY: key }
}

function credentials() {
  const stored = readEnvFile()
  const url = process.env.SOURCELENS_MCP_URL || stored.SOURCELENS_MCP_URL
  const key = process.env.SOURCELENS_API_KEY || stored.SOURCELENS_API_KEY
  if (!url) die('SOURCELENS_MCP_URL is not set. Run: sourcelens install')
  if (!key) die('SOURCELENS_API_KEY is not set. Run: sourcelens install')
  return { url, key }
}

function endpoint(url) {
  const parsed = new URL(url)
  const mcpPath = parsed.pathname.replace(/\/+$/, '')
  return {
    origin: parsed.origin,
    assistants: `${parsed.origin}${mcpPath.replace(/\/mcp$/, '')}/assistants/`,
  }
}

async function request(url, { method = 'GET', key, lang, body, signal } = {}) {
  const headers = { Authorization: `Bearer ${key}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (lang) headers['Accept-Language'] = lang
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  return { status: response.status, payload }
}

function unwrap(result) {
  if (result.status >= 400) {
    die(`request failed (${result.status}): ${JSON.stringify(result.payload)}`)
  }
  const payload = result.payload
  if (payload && typeof payload === 'object' && payload.jsonrpc) {
    return payload
  }
  return payload.data
}

async function listAssistants(url, key, lang) {
  const collected = []
  let next = endpoint(url).assistants
  while (next) {
    const page = unwrap(await request(next, { key, lang }))
    collected.push(...(page.results || []))
    next = page.next
  }
  return collected.map((assistant) => ({
    uuid: assistant.uuid,
    slug: assistant.slug,
    name: assistant.name,
    capability: assistant.capability,
    mode: assistant.mode || assistant.routing_mode,
    status: assistant.status,
    description: assistant.description || '',
    routing_description: assistant.routing_description || '',
    datasources: (assistant.datasource_bindings || [])
      .map((binding) => binding.datasource_name)
      .filter(Boolean),
  }))
}

async function resolveAssistant(selector, url, key, lang) {
  const catalog = await listAssistants(url, key, lang)
  const needle = String(selector).toLowerCase()
  const match = catalog.find((assistant) =>
    [assistant.uuid, assistant.slug, assistant.name].some(
      (candidate) => String(candidate || '').toLowerCase() === needle
    )
  )
  if (match) return match.uuid
  const partial = catalog.filter((assistant) =>
    assistant.name.toLowerCase().includes(needle)
  )
  if (partial.length === 1) return partial[0].uuid
  if (partial.length > 1) {
    die(`assistant "${selector}" is ambiguous: ${partial.map((a) => a.name).join(', ')}`)
  }
  die(`assistant "${selector}" not found. Run: sourcelens assistants`)
}

function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
      char
    )
      ? 2
      : 1
  }
  return width
}

function padEnd(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function printTable(rows) {
  if (!rows.length) {
    console.log('No assistants available.')
    return
  }
  const columns = ['name', 'slug', 'capability', 'mode', 'datasources', 'routing_description']
  const table = rows.map((row) => ({
    name: row.name,
    slug: row.slug,
    capability: row.capability,
    mode: row.mode,
    datasources: row.datasources.join(', '),
    routing_description: row.routing_description.replace(/\s+/g, ' '),
  }))
  const widths = columns.map((column) =>
    Math.max(
      displayWidth(column),
      ...table.map((row) => displayWidth(row[column]))
    )
  )
  const line = (row) =>
    columns.map((column, index) => padEnd(String(row[column]), widths[index])).join('  ')
  console.log(line(Object.fromEntries(columns.map((column) => [column, column]))))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  table.forEach((row) => console.log(line(row)))
}

async function cmdInstall(argv) {
  const result = spawnSync('bash', [path.join(__dirname, '..', 'install.sh'), ...argv], {
    stdio: 'inherit',
  })
  process.exit(result.status || 0)
}

async function cmdAssistants(argv) {
  const options = parseArgs(argv, { json: 'bool', lang: 'value' })
  const { url, key } = credentials()
  const catalog = await listAssistants(url, key, options.lang)
  if (options.json) {
    console.log(JSON.stringify(catalog, null, 2))
    return
  }
  printTable(catalog)
}

async function cmdAsk(argv) {
  const options = parseArgs(argv, {
    assistant: 'value',
    tool: 'value',
    workspace: 'value',
    'max-results': 'value',
    timeout: 'value',
    json: 'bool',
    lang: 'value',
  })
  const query = options._.join(' ').trim()
  if (!query) die('ask requires a question, e.g. sourcelens ask "..." --assistant <name>')
  if (!options.assistant) die('ask requires --assistant <slug|uuid|name>')
  const tool = options.tool || 'sourcelens_ask'
  if (!TOOLS.includes(tool)) die(`--tool must be one of: ${TOOLS.join(', ')}`)
  const timeout = Number(options.timeout || DEFAULT_TIMEOUT_S)
  if (!Number.isFinite(timeout) || timeout <= 0) die('--timeout must be a positive number')

  const { url, key } = credentials()
  const assistantUuid = await resolveAssistant(options.assistant, url, key, options.lang)
  const args = { assistant_uuid: assistantUuid, query }
  if (options.workspace) args.workspace = options.workspace
  if (options['max-results']) args.max_results = Number(options['max-results'])

  const call = unwrap(
    await request(url, {
      method: 'POST',
      key,
      lang: options.lang,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      },
    })
  )
  const result = call.result || {}
  const text = (result.content || []).map((part) => part.text).join('')
  const runUuid = (text.match(/run_uuid=(\S+)/) || [])[1]
  const resultPath = (text.match(/result_path=(\S+)/) || [])[1]
  if (!runUuid || !resultPath) die(`unexpected gateway response: ${text || JSON.stringify(call)}`)

  const deadline = Date.now() + timeout * 1000
  let run
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deadline - Date.now())
    try {
      run = unwrap(
        await request(new URL(resultPath, endpoint(url).origin), {
          key,
          lang: options.lang,
          signal: controller.signal,
        })
      )
    } catch (error) {
      if (!controller.signal.aborted) throw error
      break
    } finally {
      clearTimeout(timer)
    }
    if (['done', 'failed', 'error', 'cancelled'].includes(run.status)) break
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  const unfinished = !run || !['done', 'failed', 'error', 'cancelled'].includes(run.status)
  if (options.json) {
    if (run !== undefined) console.log(JSON.stringify(run, null, 2))
    if (unfinished) console.error('timed out waiting for the assistant result')
    if (!run || run.status !== 'done') process.exitCode = 1
    return
  }
  if (!run) die('timed out before the assistant produced a result')
  console.log(run.answer || `(no answer; status=${run.status})`)
  const citations = run.citations || []
  if (citations.length) {
    console.log('\nCitations:')
    citations.forEach((citation) => console.log(`- ${JSON.stringify(citation)}`))
  }
  if (run.status !== 'done') process.exitCode = 1
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  switch (command) {
    case 'install':
      return cmdInstall(argv)
    case 'assistants':
      return cmdAssistants(argv)
    case 'ask':
      return cmdAsk(argv)
    case 'help':
    case undefined:
      usage()
      return process.exit(command === undefined ? 2 : 0)
    default:
      die(`unknown command: ${command}`)
  }
}

main().catch((error) => die(error.stack || String(error), 1))
