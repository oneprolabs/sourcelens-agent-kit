const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const cli = path.resolve(__dirname, '../bin/sourcelens.js')
const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x0a])
const file = {
  uuid: 'file-1', url: '/api/lens/output-files/file-1/', filename: '报告.xlsx',
  status: 'published', byte_size: bytes.length, content_type: 'application/octet-stream',
}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcelens-download-'))
  const requests = []
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    requests.push({ url: req.url, method: req.method, headers: req.headers })
    const json = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data }))
    }
    if (req.url === '/api/lens/assistants/') return json({ results: [{ uuid: 'assistant-1', slug: 'docs' }] })
    if (req.url === '/api/lens/sessions/') return json({ uuid: 'session-1' })
    const run = { uuid: options.runUuid || 'run-1', status: options.status || 'done', answer: 'Report ready', citations: [] }
    if (options.files !== null) run.output_files = options.files || [file]
    if (req.url === '/api/lens/sessions/session-1/runs/' || req.url === '/api/lens/runs/run-1/') return json(run)
    if (options.download) return options.download(req, res)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const destination = path.join(dir, 'artifacts')
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, SOURCELENS_HOME: dir, SOURCELENS_BASE_URL: origin, SOURCELENS_API_KEY: 'sl_agent_test-key' },
      timeout: 6000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, killed: Boolean(error?.killed) }))
  })
  return { dir, destination, requests, run }
}

const ask = ['ask', 'Generate report', '--assistant', 'docs']

test('ask downloads binary deliverables and returns local paths with metadata', async (t) => {
  const { run, destination, requests } = await fixture(t)
  const result = await run([...ask, '--download-dir', destination, '--json', '--lang', 'zh'])
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.answer, 'Report ready')
  assert.equal(payload.output_files[0].download_status, 'downloaded')
  const local = payload.output_files[0].local_path
  assert.equal(local, path.join(fs.realpathSync(destination), 'run-1', file.filename))
  assert.deepEqual(fs.readFileSync(local), bytes)
  const download = requests.find((req) => req.url === file.url)
  assert.equal(download.headers.authorization, 'Bearer sl_agent_test-key')
  assert.equal(download.headers['accept-language'], 'zh')
})

test('without download-dir ask displays attachments and does not download', async (t) => {
  const { run, requests, destination } = await fixture(t)
  const result = await run(ask)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /报告.xlsx/)
  assert.match(result.stdout, /output-files/)
  assert.equal(requests.some((req) => req.url === file.url), false)
  assert.equal(fs.existsSync(destination), false)
})

test('download retrieves an existing run without creating a new question', async (t) => {
  const { run, destination, requests } = await fixture(t)
  const result = await run(['download', 'run-1', '--download-dir', destination, '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(fs.readFileSync(JSON.parse(result.stdout).output_files[0].local_path), bytes)
  assert.equal(requests.some((req) => req.method !== 'GET'), false)
})

test('existing files are never overwritten and JSON preserves the answer on failure', async (t) => {
  const { run, destination } = await fixture(t)
  fs.mkdirSync(path.join(destination, 'run-1'), { recursive: true })
  const target = path.join(destination, 'run-1', file.filename)
  fs.writeFileSync(target, 'keep me')
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.answer, 'Report ready')
  assert.equal(payload.output_files[0].download_status, 'failed')
  assert.equal(payload.output_files[0].local_path, undefined)
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me')
})

test('a symlink file cannot overwrite a file outside the download directory', async (t) => {
  const { run, dir, destination } = await fixture(t)
  const outside = path.join(dir, 'outside')
  fs.writeFileSync(outside, 'keep me')
  fs.mkdirSync(path.join(destination, 'run-1'), { recursive: true })
  fs.symlinkSync(outside, path.join(destination, 'run-1', file.filename))
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me')
})

test('a symlink run directory cannot redirect downloaded files', async (t) => {
  const { run, dir, destination } = await fixture(t)
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(outside)
  fs.mkdirSync(destination)
  fs.symlinkSync(outside, path.join(destination, 'run-1'))
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.deepEqual(fs.readdirSync(outside), [])
})

for (const filename of ['../escape', '/tmp/escape', '..\\escape', '..', 'bad\nname']) {
  test(`unsafe filename ${JSON.stringify(filename)} is rejected`, async (t) => {
    const { run, destination, requests } = await fixture(t, { files: [{ ...file, filename }] })
    const result = await run([...ask, '--download-dir', destination, '--json'])
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).output_files[0].download_status, 'failed')
    assert.equal(requests.some((req) => req.url === file.url), false)
  })
}

test('unsafe run identifiers cannot escape the destination', async (t) => {
  const { run, destination } = await fixture(t, { runUuid: '../escape' })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).output_files[0].download_status, 'failed')
  assert.equal(fs.existsSync(destination), false)
})

for (const url of ['http://127.0.0.1:1/steal', '//127.0.0.1:1/steal']) {
  test(`external file URL ${url} is rejected before sending credentials`, async (t) => {
    const { run, destination } = await fixture(t, { files: [{ ...file, url }] })
    const result = await run([...ask, '--download-dir', destination, '--json'])
    assert.equal(result.code, 1)
    assert.match(JSON.parse(result.stdout).output_files[0].download_error, /origin/i)
  })
}

test('redirects are refused rather than forwarding credentials', async (t) => {
  const { run, destination, requests } = await fixture(t, {
    download: (req, res) => { res.writeHead(302, { Location: '/steal' }); res.end() },
  })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.match(JSON.parse(result.stdout).output_files[0].download_error, /302/)
  assert.equal(requests.some((req) => req.url === '/steal'), false)
})

test('partial download failures keep successful files and remove incomplete bytes', async (t) => {
  const { run, destination } = await fixture(t, {
    files: [file, { ...file, uuid: 'file-2', filename: 'second.xlsx', url: '/api/lens/output-files/file-2/' }],
    download: (req, res) => {
      if (req.url === file.url) { res.writeHead(403); res.end('denied'); return }
      res.writeHead(200)
      res.end(bytes)
    },
  })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  const files = JSON.parse(result.stdout).output_files
  assert.equal(files[0].download_status, 'failed')
  assert.equal(files[1].download_status, 'downloaded')
  assert.deepEqual(fs.readdirSync(path.join(destination, 'run-1')), ['second.xlsx'])
})

test('truncated bytes fail integrity validation and leave no partial file', async (t) => {
  const { run, destination } = await fixture(t, { download: (req, res) => res.end(bytes.subarray(0, 2)) })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.match(JSON.parse(result.stdout).output_files[0].download_error, /size/i)
  assert.deepEqual(fs.readdirSync(path.join(destination, 'run-1')), [])
})

test('stalled downloads abort within the download timeout and keep JSON parseable', async (t) => {
  const { run, destination } = await fixture(t, { download: (req, res) => { res.writeHead(200); res.write(bytes.subarray(0, 2)) } })
  const result = await run([...ask, '--download-dir', destination, '--timeout', '0.1', '--json'])
  assert.equal(result.killed, false)
  assert.equal(result.code, 1)
  assert.match(JSON.parse(result.stdout).output_files[0].download_error, /timed out/i)
  assert.deepEqual(fs.readdirSync(path.join(destination, 'run-1')), [])
})

test('unpublished files are not downloaded', async (t) => {
  const { run, destination, requests } = await fixture(t, { files: [{ ...file, status: 'candidate' }] })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.equal(requests.some((req) => req.url === file.url), false)
})

test('empty attachment collections succeed without creating a directory', async (t) => {
  const { run, destination } = await fixture(t, { files: [] })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(fs.existsSync(destination), false)
})

test('older servers report missing metadata when asked to download but still answer normally', async (t) => {
  const { run, destination } = await fixture(t, { files: null })
  assert.equal((await run([...ask, '--json'])).code, 0)
  for (const command of [ask, ['download', 'run-1']]) {
    const result = await run([...command, '--download-dir', destination, '--json'])
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).answer, 'Report ready')
    assert.match(result.stderr, /server does not expose output_files/)
    assert.equal(fs.existsSync(destination), false)
  }
})

test('duplicate filenames keep both attachments using a UUID prefix', async (t) => {
  const { run, destination } = await fixture(t, { files: [file, { ...file, uuid: 'file-2' }] })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 0, result.stderr)
  const files = JSON.parse(result.stdout).output_files
  assert.notEqual(files[0].local_path, files[1].local_path)
  assert.deepEqual(fs.readFileSync(files[0].local_path), bytes)
  assert.deepEqual(fs.readFileSync(files[1].local_path), bytes)
})

for (const [description, files] of [
  ['case equivalent names', [{ ...file, filename: 'Report.xlsx' }, { ...file, uuid: 'file-2', filename: 'report.xlsx' }]],
  ['Unicode equivalent names', [{ ...file, filename: 'caf\u00e9.xlsx' }, { ...file, uuid: 'file-2', filename: 'cafe\u0301.xlsx' }]],
  ['a UUID prefix matching an earlier original name', [
    { ...file, filename: `file-3-${file.filename}` },
    { ...file, uuid: 'file-2' },
    { ...file, uuid: 'file-3' },
  ]],
]) {
  test(`name allocation preserves every attachment with ${description}`, async (t) => {
    const { run, destination } = await fixture(t, { files })
    const result = await run([...ask, '--download-dir', destination, '--json'])
    assert.equal(result.code, 0, result.stderr)
    const downloaded = JSON.parse(result.stdout).output_files
    assert.equal(new Set(downloaded.map((item) => fs.realpathSync(item.local_path))).size, files.length)
    for (const item of downloaded) {
      assert.equal(item.download_status, 'downloaded')
      assert.deepEqual(fs.readFileSync(item.local_path), bytes)
    }
  })
}

for (const filename of [`${'a'.repeat(240)}.xlsx`, `${'报'.repeat(100)}.xlsx`]) {
  test(`long ${filename.startsWith('a') ? 'ASCII' : 'Unicode'} names retain extensions and fit after deduplication`, async (t) => {
    const { run, destination } = await fixture(t, { files: [
      { ...file, filename },
      { ...file, uuid: '22222222-2222-2222-2222-222222222222', filename },
    ] })
    const result = await run([...ask, '--download-dir', destination, '--json'])
    assert.equal(result.code, 0, result.stderr)
    const downloaded = JSON.parse(result.stdout).output_files
    assert.notEqual(downloaded[0].local_path, downloaded[1].local_path)
    for (const item of downloaded) {
      assert.equal(path.extname(item.local_path), '.xlsx')
      assert.ok(Buffer.byteLength(path.basename(item.local_path).normalize('NFD')) <= 255)
      assert.deepEqual(fs.readFileSync(item.local_path), bytes)
    }
  })
}

test('text mode prints downloaded local paths', async (t) => {
  const { run, destination } = await fixture(t)
  const result = await run([...ask, '--download-dir', destination])
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.stdout.includes(path.join(fs.realpathSync(destination), 'run-1', file.filename)))
})

for (const status of ['failed', 'running']) {
  test(`download refuses a ${status} run without fetching files`, async (t) => {
    const { run, destination, requests } = await fixture(t, { status })
    const result = await run(['download', 'run-1', '--download-dir', destination, '--json'])
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).status, status)
    assert.equal(requests.some((req) => req.url === file.url), false)
    assert.equal(fs.existsSync(destination), false)
  })
}

test('oversized downloads abort and remove partial files', async (t) => {
  const { run, destination } = await fixture(t, { files: [{ ...file, byte_size: 1 }] })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 1)
  assert.match(JSON.parse(result.stdout).output_files[0].download_error, /size/)
  assert.deepEqual(fs.readdirSync(path.join(destination, 'run-1')), [])
})

test('empty deliverables are saved as zero-byte files', async (t) => {
  const { run, destination } = await fixture(t, { files: [{ ...file, byte_size: 0 }], download: (req, res) => res.end() })
  const result = await run([...ask, '--download-dir', destination, '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(fs.statSync(JSON.parse(result.stdout).output_files[0].local_path).size, 0)
})
