#!/usr/bin/env node

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

const POLL_INTERVAL_MS = 1500
const DEFAULT_TIMEOUT_S = 180
const TERMINAL_STATUSES = ['done', 'failed', 'error', 'cancelled']

function die(message, code = 2) {
  console.error(message)
  process.exit(code)
}

function usage() {
  console.error(`Usage: sourcelens <command> [options]

Commands:
  install [--url URL] [--api-key KEY] [--no-auth]
        Install the SourceLens Q&A skill, store credentials, and add the CLI
        to PATH. Pass --no-auth to skip credentials setup.

  assistants [--json] [--lang zh|en|es]
        List assistants with the routing synopsis used to choose one.

  ping [--json] [--lang zh|en|es]
        Verify the service URL and credentials. Spends no Q&A run.

  ask "<question>" --assistant <slug|uuid|name> [--timeout S] [--json]
        [--lang zh|en|es] [--download-dir DIR]
        Ask one assistant and wait for the answer.
        Optionally save published files under DIR/<run UUID>/.

  download <run-uuid> --download-dir DIR [--timeout S] [--json]
        [--lang zh|en|es]
        Download files from an existing completed run without asking again.

Credentials come from SOURCELENS_BASE_URL and SOURCELENS_API_KEY, or from
~/.config/sourcelens/env written by 'sourcelens install'.`)
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

function configDir() {
  if (process.env.SOURCELENS_CONFIG_HOME) return process.env.SOURCELENS_CONFIG_HOME
  if (process.env.SOURCELENS_HOME) return process.env.SOURCELENS_HOME
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'sourcelens')
}

function envFilePath() {
  return path.join(configDir(), 'env')
}

function readEnvFile() {
  const file = envFilePath()
  if (!fs.existsSync(file)) return {}
  const script =
    'set -a; . "$1" 2>/dev/null; set +a; ' +
    'printf "%s\\0%s\\0" "${SOURCELENS_BASE_URL:-}" "${SOURCELENS_API_KEY:-}"'
  const result = spawnSync('bash', ['-c', script, 'sourcelens', file], { encoding: 'utf8' })
  if (result.status !== 0) return {}
  const [url, key] = result.stdout.split('\0')
  return { SOURCELENS_BASE_URL: url, SOURCELENS_API_KEY: key }
}

function normalizeBase(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    die(`invalid SOURCELENS_BASE_URL: ${url}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

function credentials() {
  const stored = readEnvFile()
  const url = process.env.SOURCELENS_BASE_URL || stored.SOURCELENS_BASE_URL
  const key = process.env.SOURCELENS_API_KEY || stored.SOURCELENS_API_KEY
  if (!url) die('SOURCELENS_BASE_URL is not set. Run: sourcelens install')
  if (!key) die('SOURCELENS_API_KEY is not set. Run: sourcelens install')
  return { url: normalizeBase(url), key }
}

function endpoints(base) {
  return {
    assistants: `${base}/api/lens/assistants/`,
    sessions: `${base}/api/lens/sessions/`,
    sessionRuns: (uuid) => `${base}/api/lens/sessions/${uuid}/runs/`,
    run: (uuid) => `${base}/api/lens/runs/${uuid}/`,
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
  if (payload && typeof payload === 'object' && payload.data !== undefined) {
    return payload.data
  }
  return payload
}

async function listAssistants(url, key, lang) {
  const collected = []
  let next = endpoints(url).assistants
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

async function cmdPing(argv) {
  const options = parseArgs(argv, { json: 'bool', lang: 'value' })
  const { url, key } = credentials()
  const page = unwrap(
    await request(endpoints(url).assistants, { key, lang: options.lang })
  )
  const visible = (page.results || []).length
  if (options.json) {
    console.log(JSON.stringify({ url, assistants: visible }, null, 2))
    return
  }
  console.log(`SourceLens service OK: ${url}`)
  console.log(`assistants visible: ${visible}`)
}

function timeoutSeconds(options) {
  const timeout = Number(options.timeout || DEFAULT_TIMEOUT_S)
  if (!Number.isFinite(timeout) || timeout <= 0) die('--timeout must be a positive number')
  return timeout
}

function safePathSegment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error('unsafe file name or run identifier')
  }
  return value
}

async function downloadFile(file, runUuid, directory, { url, key, lang, timeout }, filename) {
  safePathSegment(runUuid)
  safePathSegment(filename)
  if (file.status !== 'published') throw new Error('file is not published')
  if (!Number.isSafeInteger(file.byte_size) || file.byte_size < 0) throw new Error('invalid file byte size')
  if (typeof file.url !== 'string' || !file.url) throw new Error('missing file URL')
  const remote = new URL(file.url, `${url}/`)
  if (remote.origin !== new URL(url).origin || remote.username || remote.password) {
    throw new Error('file URL must use the SourceLens service origin')
  }

  await fs.promises.mkdir(path.resolve(directory), { recursive: true, mode: 0o700 })
  const root = await fs.promises.realpath(directory)
  const runDir = path.join(root, runUuid)
  await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 })
  if ((await fs.promises.lstat(runDir)).isSymbolicLink()) throw new Error('run directory must not be a symbolic link')
  const target = path.join(runDir, filename)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout * 1000)
  let handle
  let completed = false
  try {
    handle = await fs.promises.open(target, 'wx', 0o600)
    const headers = { Authorization: `Bearer ${key}` }
    if (lang) headers['Accept-Language'] = lang
    const response = await fetch(remote, { headers, redirect: 'manual', signal: controller.signal })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`file download failed (HTTP ${response.status})`)
    }
    let size = 0
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length
        callback(size > file.byte_size ? new Error('file size exceeds metadata') : null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), counter, handle.createWriteStream(), { signal: controller.signal })
    if (size !== file.byte_size) throw new Error('file size does not match metadata')
    completed = true
    return target
  } catch (error) {
    if (controller.signal.aborted) throw new Error('file download timed out')
    throw error
  } finally {
    clearTimeout(timer)
    if (handle) {
      await handle.close()
      if (!completed) await fs.promises.unlink(target)
    }
  }
}

function outputFilename(original, prefix = '') {
  const extension = path.extname(original)
  const stem = Array.from(original.slice(0, original.length - extension.length))
  // Count decomposed UTF-8 bytes so names also fit common macOS filesystems.
  do {
    const filename = `${prefix}${stem.join('')}${extension}`
    if (Buffer.byteLength(filename.normalize('NFD')) <= 255) return safePathSegment(filename)
  } while (stem.pop() !== undefined)
  throw new Error('file name prefix or extension exceeds local filesystem limit')
}

async function downloadOutputFiles(run, directory, config) {
  if (!directory || run.status !== 'done') return
  if (!Array.isArray(run.output_files)) {
    console.error('server does not expose output_files; update SourceLens before downloading deliverables')
    process.exitCode = 1
    return
  }
  const usedNames = new Set()
  // Reserve case and Unicode equivalents too, for common macOS filesystems.
  const nameKey = (name) => name.normalize('NFD').toLowerCase()
  for (const file of run.output_files || []) {
    delete file.local_path
    delete file.download_error
    try {
      const original = safePathSegment(file.filename)
      let filename = outputFilename(original)
      let attempt = 0
      while (usedNames.has(nameKey(filename))) {
        const prefix = safePathSegment(file.uuid)
        filename = outputFilename(original, `${prefix}-${attempt ? `${attempt}-` : ''}`)
        attempt += 1
      }
      usedNames.add(nameKey(filename))
      file.local_path = await downloadFile(file, run.uuid, directory, config, filename)
      file.download_status = 'downloaded'
    } catch (error) {
      file.download_status = 'failed'
      file.download_error = error.message
      console.error(`File ${JSON.stringify(file.filename)}: ${error.message}`)
      process.exitCode = 1
    }
  }
}

function printOutputFiles(run) {
  if (!run.output_files?.length) return
  console.log('\nFiles:')
  for (const file of run.output_files) {
    console.log(`- ${JSON.stringify(file.filename)}: ${file.local_path || file.url}`)
    if (file.download_error) console.log(`  Download failed: ${file.download_error}`)
  }
}

async function cmdDownload(argv) {
  const options = parseArgs(argv, { 'download-dir': 'value', timeout: 'value', json: 'bool', lang: 'value' })
  if (options._.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(options._[0])) die('download requires one run UUID')
  if (!options['download-dir']) die('download requires --download-dir DIR')
  const timeout = timeoutSeconds(options)
  const { url, key } = credentials()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout * 1000)
  let run
  try {
    run = unwrap(await request(endpoints(url).run(options._[0]), { key, lang: options.lang, signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
  await downloadOutputFiles(run, options['download-dir'], { url, key, lang: options.lang, timeout })
  if (options.json) console.log(JSON.stringify(run, null, 2))
  else printOutputFiles(run)
  if (run.status !== 'done') {
    console.error(`run is not completed (status=${run.status}); no files downloaded`)
    process.exitCode = 1
  }
}

async function cmdAsk(argv) {
  const options = parseArgs(argv, {
    assistant: 'value',
    timeout: 'value',
    json: 'bool',
    lang: 'value',
    'download-dir': 'value',
  })
  const query = options._.join(' ').trim()
  if (!query) die('ask requires a question, e.g. sourcelens ask "..." --assistant <name>')
  if (!options.assistant) die('ask requires --assistant <slug|uuid|name>')
  const timeout = timeoutSeconds(options)

  const { url, key } = credentials()
  const api = endpoints(url)
  const assistantUuid = await resolveAssistant(options.assistant, url, key, options.lang)

  const session = unwrap(
    await request(api.sessions, {
      method: 'POST',
      key,
      lang: options.lang,
      body: { assistant_uuid: assistantUuid },
    })
  )
  if (!session || !session.uuid) {
    die(`unexpected session response: ${JSON.stringify(session)}`)
  }

  const created = unwrap(
    await request(api.sessionRuns(session.uuid), {
      method: 'POST',
      key,
      lang: options.lang,
      body: {
        question: query,
        request_source: {
          channel: 'cli',
          client: process.env.SOURCELENS_CLIENT || 'unknown',
        },
      },
    })
  )
  const runUuid = created && created.uuid
  if (!runUuid) die(`unexpected run response: ${JSON.stringify(created)}`)

  const deadline = Date.now() + timeout * 1000
  let run = created
  while (!TERMINAL_STATUSES.includes(run.status) && Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deadline - Date.now())
    try {
      run = unwrap(
        await request(api.run(runUuid), {
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
    if (TERMINAL_STATUSES.includes(run.status)) break
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  const unfinished = !run || !TERMINAL_STATUSES.includes(run.status)
  if (run) await downloadOutputFiles(run, options['download-dir'], { url, key, lang: options.lang, timeout })
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
  printOutputFiles(run)
  if (run.status !== 'done') process.exitCode = 1
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  switch (command) {
    case 'install':
      return cmdInstall(argv)
    case 'assistants':
      return cmdAssistants(argv)
    case 'ping':
      return cmdPing(argv)
    case 'ask':
      return cmdAsk(argv)
    case 'download':
      return cmdDownload(argv)
    case 'help':
    case undefined:
      usage()
      return process.exit(command === undefined ? 2 : 0)
    default:
      die(`unknown command: ${command}`)
  }
}

main().catch((error) => die(error.stack || String(error), 1))
