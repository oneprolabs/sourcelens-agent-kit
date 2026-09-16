const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const cli = path.resolve(__dirname, '../bin/sourcelens.js')
const assistant = {
  uuid: 'assistant-1', slug: 'docs', name: '文档助手', capability: 'knowledge_qa',
  routing_mode: 'direct', routing_description: 'Project documentation',
  datasource_bindings: [{ datasource_name: 'Docs' }],
}
const answer = {
  run_uuid: 'run-1', status: 'done', answer: 'The project provides Q&A.',
  citations: [{ path: 'README.md', start_line: 1, end_line: 3 }],
}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcelens-cli-'))
  const requests = []
  let polls = 0
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null })
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (options.httpError) return json({ detail: 'Access denied' }, options.httpError)
    if (req.url.startsWith('/api/assistants/')) {
      const page = new URL(req.url, 'http://localhost').searchParams.get('page')
      const rows = options.catalog || [assistant]
      return json({ data: {
        results: options.paginated && !page ? Array.from({ length: 200 }, (_, i) => ({ ...assistant, uuid: `uuid-${i}`, slug: `slug-${i}` })) : rows,
        next: options.paginated && !page ? `${origin}/api/assistants/?page=2` : null,
      } })
    }
    if (req.url === '/api/mcp') {
      const body = raw ? JSON.parse(raw) : {}
      if (options.rpcError) return json(options.rpcError)
      if (body.method === 'initialize') return json({
        jsonrpc: '2.0', id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'sourcelens-qa', version: '1.0.0' },
        },
      })
      if (body.method === 'tools/list') return json({
        jsonrpc: '2.0', id: body.id,
        result: { tools: options.tools || [{ name: 'sourcelens_ask' }, { name: 'sourcelens_search' }] },
      })
      return json({
        jsonrpc: '2.0', id: body.id,
        result: { content: [{ type: 'text', text: 'run_uuid=run-1 result_path=/api/runs/run-1/' }] },
      })
    }
    if (req.url === '/api/runs/run-1/') {
      polls += 1
      if (options.hang === 'headers') return
      if (options.hang === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"data":')
        return
      }
      return json({ data: { ...answer, status: options.status || (options.pendingFirst && polls === 1 ? 'running' : 'done') } })
    }
    json({ detail: 'Unexpected route' }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const env = { ...process.env, SOURCELENS_HOME: dir, SOURCELENS_MCP_URL: `${origin}/api/mcp`, SOURCELENS_API_KEY: 'test-key' }
  const run = (args, overrides = {}, timeout = 6000) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...env, ...overrides }, timeout }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, killed: Boolean(error?.killed), stdout, stderr })
    })
  })
  return { dir, env, requests, run }
}

const ask = ['ask', 'What does this project do?', '--assistant', 'docs']

test('assistant discovery preserves routing metadata, auth and language', async (t) => {
  const { run, requests } = await fixture(t)
  const result = await run(['assistants', '--json', '--lang', 'zh'])
  assert.equal(result.code, 0, result.stderr)
  const rows = JSON.parse(result.stdout)
  assert.equal(rows[0].mode, 'direct')
  assert.deepEqual(rows[0].datasources, ['Docs'])
  assert.equal(rows[0].routing_description, assistant.routing_description)
  assert.equal(requests[0].headers.authorization, 'Bearer test-key')
  assert.equal(requests[0].headers['accept-language'], 'zh')
})

test('pagination discovers and resolves assistants beyond the first 200', async (t) => {
  const { run, requests } = await fixture(t, { paginated: true })
  const listed = await run(['assistants', '--json'])
  assert.equal(JSON.parse(listed.stdout).length, 201)
  const result = await run([...ask, '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(requests.find((req) => req.method === 'POST').body.params.arguments.assistant_uuid, assistant.uuid)
})

test('empty assistant catalog has a readable message', async (t) => {
  const { run } = await fixture(t, { catalog: [] })
  const result = await run(['assistants'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /No assistants available/)
})

test('ping reports the MCP server and its read-only tools', async (t) => {
  const { run, requests } = await fixture(t)
  const result = await run(['ping', '--json'])
  assert.equal(result.code, 0, result.stderr)
  const info = JSON.parse(result.stdout)
  assert.equal(info.server, 'sourcelens-qa')
  assert.equal(info.protocolVersion, '2025-03-26')
  assert.deepEqual(info.tools, ['sourcelens_ask', 'sourcelens_search'])
  assert.equal(requests[0].body.method, 'initialize')
  assert.equal(requests[1].body.method, 'tools/list')
  assert.equal(requests[0].headers.authorization, 'Bearer test-key')
  assert.equal(requests.some((req) => req.url.includes('/runs/')), false)
})

test('ping fails when a read-only tool is missing', async (t) => {
  const { run } = await fixture(t, { tools: [{ name: 'sourcelens_ask' }] })
  const result = await run(['ping'])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /sourcelens_search/)
})

for (const selector of ['DOCS', 'assistant-1', '文档助手', '文档']) {
  test(`ask resolves selector ${selector} and returns answer with citations`, async (t) => {
    const { run } = await fixture(t)
    const result = await run(['ask', 'question', '--assistant', selector, '--json'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), answer)
  })
}

test('search forwards workspace, result limit and language, then polls to completion', async (t) => {
  const { run, requests } = await fixture(t, { pendingFirst: true })
  const result = await run([...ask, '--tool', 'sourcelens_search', '--workspace', 'Docs', '--max-results', '3', '--lang', 'zh'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /The project provides Q&A/)
  assert.match(result.stdout, /README.md/)
  const call = requests.find((req) => req.method === 'POST')
  assert.equal(call.body.params.name, 'sourcelens_search')
  assert.deepEqual(call.body.params.arguments, {
    assistant_uuid: assistant.uuid, query: ask[1], workspace: 'Docs', max_results: 3,
  })
  assert.equal(requests.filter((req) => req.url.includes('/runs/')).length, 2)
})

for (const status of ['failed', 'error', 'cancelled']) {
  for (const json of [false, true]) {
    test(`${status} run exits unsuccessfully in ${json ? 'JSON' : 'text'} mode`, async (t) => {
      const { run } = await fixture(t, { status })
      const result = await run([...ask, ...(json ? ['--json'] : [])])
      assert.equal(result.code, 1)
      if (json) assert.equal(JSON.parse(result.stdout).status, status)
    })
  }
}

for (const [selector, message] of [['missing', /not found/], ['文档', /ambiguous/]]) {
  test(`invalid assistant ${selector} never submits a run`, async (t) => {
    const { run, requests } = await fixture(t, { catalog: [assistant, { ...assistant, name: '文档备份助手', uuid: 'assistant-2', slug: 'backup' }] })
    const result = await run(['ask', 'question', '--assistant', selector])
    assert.equal(result.code, 2)
    assert.match(result.stderr, message)
    assert.equal(requests.some((req) => req.method === 'POST'), false)
  })
}

test('credentials fall back to env file and environment overrides stored values', async (t) => {
  const { run, dir, env, requests } = await fixture(t)
  fs.writeFileSync(path.join(dir, 'env'), `export SOURCELENS_MCP_URL='${env.SOURCELENS_MCP_URL}'\nexport SOURCELENS_API_KEY='stored-key'\n`, { mode: 0o600 })
  assert.equal((await run(['assistants', '--json'], { SOURCELENS_MCP_URL: '', SOURCELENS_API_KEY: '' })).code, 0)
  assert.equal(requests[0].headers.authorization, 'Bearer stored-key')
  assert.equal((await run(['assistants', '--json'])).code, 0)
  assert.equal(requests[1].headers.authorization, 'Bearer test-key')
})

test('missing credentials fails locally before contacting gateway', async (t) => {
  const { run, requests } = await fixture(t)
  const result = await run(['assistants'], { SOURCELENS_API_KEY: '' })
  assert.equal(result.code, 2)
  assert.match(result.stderr, /SOURCELENS_API_KEY is not set/)
  assert.equal(requests.length, 0)
})

test('HTTP unauthorized response produces nonzero exit and useful error', async (t) => {
  const { run } = await fixture(t, { httpError: 401 })
  const result = await run(['assistants', '--json'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /401.*Access denied/)
})

test('JSON-RPC tool error does not start polling', async (t) => {
  const { run, requests } = await fixture(t, { rpcError: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid assistant' } } })
  const result = await run(ask)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /Invalid assistant/)
  assert.equal(requests.some((req) => req.url.includes('/runs/')), false)
})

for (const hang of ['headers', 'body']) {
  test(`timeout aborts a result request stalled at ${hang}`, async (t) => {
    const { run } = await fixture(t, { hang })
    const result = await run([...ask, '--timeout', '0.1', '--json'], {}, 2000)
    assert.equal(result.killed, false, 'CLI ignored its timeout and required external termination')
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /timed out/i)
  })
}

test('unfinished run at deadline reports a timeout and keeps JSON parseable', async (t) => {
  const { run } = await fixture(t, { status: 'running' })
  const result = await run([...ask, '--timeout', '0.1', '--json'])
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).status, 'running')
  assert.match(result.stderr, /timed out/i)
})

for (const timeout of ['abc', '-1', '0', 'Infinity']) {
  test(`invalid timeout ${timeout} is rejected before submitting work`, async (t) => {
    const { run, requests } = await fixture(t)
    const result = await run([...ask, '--timeout', timeout])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /--timeout/)
    assert.equal(requests.length, 0)
  })
}
