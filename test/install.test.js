const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcelens-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = {
    ...process.env,
    SOURCELENS_HOME: path.join(dir, 'client home'),
    SOURCELENS_PROFILE: path.join(dir, 'profile'),
    CLAUDE_HOME: path.join(dir, 'claude'),
    SOURCELENS_MCP_URL: '',
    SOURCELENS_API_KEY: '',
  }
  const run = (script, args = []) => spawnSync('bash', [script, ...args], {
    env, encoding: 'utf8', input: '',
  })
  return { env, run }
}

test('installation persists a working CLI beyond the package directory', (t) => {
  const { env, run } = fixture(t)
  const result = run(path.join(root, 'install.sh'), [
    '--client', 'claude', '--no-mcp', '--url', 'http://localhost/mcp', '--api-key', 'test-key',
  ])
  assert.equal(result.status, 0, result.stderr)
  const installed = path.join(env.SOURCELENS_HOME, 'bin', 'sourcelens')
  const help = spawnSync(installed, ['help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.error?.message || help.stderr)
  assert.match(help.stderr, /Usage: sourcelens/)
  const shell = spawnSync('bash', ['-c', '. "$SOURCELENS_PROFILE"; command -v sourcelens'], {
    env, encoding: 'utf8',
  })
  assert.equal(shell.stdout.trim(), installed)
  const reinstall = spawnSync(installed, ['install', '--client', 'claude', '--no-mcp'], {
    env, encoding: 'utf8', input: '',
  })
  assert.equal(reinstall.status, 0, reinstall.stderr)
  assert.equal(fs.readFileSync(env.SOURCELENS_PROFILE, 'utf8').match(/export PATH=/g).length, 1)
})

test('skill-only installation needs no credentials and preserves an existing env file', (t) => {
  const { env, run } = fixture(t)
  const args = ['--client', 'claude', '--no-mcp']
  const result = run(path.join(root, 'install.sh'), args)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(fs.existsSync(path.join(env.CLAUDE_HOME, 'skills/sourcelens-qa/SKILL.md')))
  const envFile = path.join(env.SOURCELENS_HOME, 'env')
  assert.equal(fs.existsSync(envFile), false)
  fs.writeFileSync(envFile, '# preserved credentials\n', { mode: 0o600 })
  assert.equal(run(path.join(root, 'install.sh'), args).status, 0)
  assert.equal(fs.readFileSync(envFile, 'utf8'), '# preserved credentials\n')
})
