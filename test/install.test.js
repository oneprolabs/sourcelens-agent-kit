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
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_BIN_HOME: path.join(dir, 'bin'),
    SOURCELENS_HOME: '',
    SOURCELENS_CONFIG_HOME: '',
    SOURCELENS_DATA_HOME: '',
    SOURCELENS_BIN_HOME: '',
    SOURCELENS_PROFILE: path.join(dir, 'profile'),
    CODEX_HOME: path.join(dir, 'codex'),
    CLAUDE_HOME: path.join(dir, 'claude'),
    SOURCELENS_BASE_URL: '',
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
    '--no-auth', '--url', 'http://localhost', '--api-key', 'test-key',
  ])
  assert.equal(result.status, 0, result.stderr)
  const installed = path.join(env.XDG_BIN_HOME, 'sourcelens')
  const help = spawnSync(installed, ['help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.error?.message || help.stderr)
  assert.match(help.stderr, /Usage: sourcelens/)
  const shell = spawnSync('bash', ['-c', '. "$SOURCELENS_PROFILE"; command -v sourcelens'], {
    env, encoding: 'utf8',
  })
  assert.equal(shell.stdout.trim(), installed)
  const reinstall = spawnSync(installed, ['install', '--no-auth'], {
    env, encoding: 'utf8', input: '',
  })
  assert.equal(reinstall.status, 0, reinstall.stderr)
  assert.equal(fs.readFileSync(env.SOURCELENS_PROFILE, 'utf8').match(/export PATH=/g).length, 1)
})

test('skill-only installation needs no credentials and preserves an existing env file', (t) => {
  const { env, run } = fixture(t)
  const args = ['--no-auth']
  const result = run(path.join(root, 'install.sh'), args)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(fs.existsSync(path.join(env.CLAUDE_HOME, 'skills/sourcelens-qa/SKILL.md')))
  assert.ok(fs.existsSync(path.join(env.CODEX_HOME, 'skills/sourcelens-qa/SKILL.md')))
  const envFile = path.join(env.XDG_CONFIG_HOME, 'sourcelens', 'env')
  assert.equal(fs.existsSync(envFile), false)
  fs.mkdirSync(path.dirname(envFile), { recursive: true })
  fs.writeFileSync(envFile, '# preserved credentials\n', { mode: 0o600 })
  assert.equal(run(path.join(root, 'install.sh'), args).status, 0)
  assert.equal(fs.readFileSync(envFile, 'utf8'), '# preserved credentials\n')
})

test('migrates credentials from the legacy ~/.sourcelens layout', (t) => {
  const { env, run } = fixture(t)
  const legacy = path.join(env.HOME, '.sourcelens')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'env'), 'export SOURCELENS_API_KEY=legacy\n', { mode: 0o600 })
  const result = run(path.join(root, 'install.sh'), ['--no-auth'])
  assert.equal(result.status, 0, result.stderr)
  const migrated = path.join(env.XDG_CONFIG_HOME, 'sourcelens', 'env')
  assert.equal(fs.readFileSync(migrated, 'utf8'), 'export SOURCELENS_API_KEY=legacy\n')
  assert.match(result.stdout, /Migrated SourceLens credentials/)
  assert.ok(fs.existsSync(legacy))
})
