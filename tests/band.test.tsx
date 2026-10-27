import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const REFRESH_MS = 15 * 60 * 1000

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const pr = (n: number, decision: string | null = null, checks: string | null = 'SUCCESS', isDraft = false) => ({
  url: `https://github.com/o/r/pull/${n}`,
  title: `PR ${n}`,
  number: n,
  repository: { nameWithOwner: 'o/r' },
  isDraft,
  reviewDecision: decision,
  commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks } : null } }] },
})

type Note = { author: { __typename: string; login: string }; createdAt: string; url: string }
type Review = { author: { __typename: string; login: string }; state: string; submittedAt: string; url: string }
type GhPr = ReturnType<typeof pr> & { comments?: { nodes: Note[] }; reviews?: { nodes: Review[] }; author?: { login: string } }
// `remote` is what `git remote get-url origin` prints; null makes it fail (no repo).
// `numstat` / `untracked` are what `git diff HEAD --numstat` and `git ls-files --others` print.
type Gh = {
  reviews: GhPr[]
  mine: GhPr[]
  merged?: GhPr[]
  assigned?: GhPr[]
  reviewed?: GhPr[]
  error?: string
  remote?: string | null
  numstat?: string
  // Raw `git diff --numstat -z` output, for records the line form cannot write (renames).
  numstatZ?: string
  untracked?: string
  patches?: Record<string, string>
  // Before the first commit / outside a repo / no way to open a browser.
  noHead?: boolean
  notRepo?: boolean
  openFails?: boolean
}

const note = (login: string, createdAt: string, url: string, typename = 'User'): Note => ({
  author: { __typename: typename, login },
  createdAt,
  url,
})
const withComments = (base: GhPr, ...notes: Note[]): GhPr => ({ ...base, comments: { nodes: notes } })

type Drawing = { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }

// New items are Markdown links: their labels, unescaped, matched against `re`.
const newsMatching = async (ui: Drawing, re: RegExp) =>
  (await ui.findAll({ type: 'Markdown' }))
    .map(md => (md.text ?? '').replace(/\\(.)/g, '$1'))
    .filter(text => re.test(text))
const hasNews = async (ui: Drawing, re: RegExp) => (await newsMatching(ui, re)).length > 0

// URLs the band asked the host to open.
const opened: string[] = []

const ok = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'failed', isStdoutTruncated: false, isStderrTruncated: false },
})

// Answers what the mod runs on the host: git (remote, diff, rev-parse, ls-files), `open`, and `gh api graphql`.
const fakeGh = (on: On, gh: Gh) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    const [cmd, sub] = e.argv
    if (cmd === 'open' || cmd === 'xdg-open') {
      if (gh.openFails) return ok('', 1)
      opened.push(e.argv[1] ?? '')
      return ok('')
    }
    if (cmd === 'git' && sub === 'remote') {
      const remote = gh.remote === undefined ? 'https://github.com/o/r.git' : gh.remote
      return remote === null ? ok('', 2) : ok(`${remote}\n`)
    }
    if (cmd === 'git' && sub === 'rev-parse') return gh.notRepo ? ok('', 128) : ok('true\n')
    if (cmd === 'git' && sub === 'diff' && !e.argv.includes('--numstat')) {
      // One file's patch: what `git diff [HEAD|--no-index] -- <file>` prints, keyed by the file.
      const file = e.argv.at(-1) ?? ''
      const patch = gh.patches?.[file] ?? ''
      return ok(patch, e.argv.includes('--no-index') && patch !== '' ? 1 : 0)
    }
    if (cmd === 'git' && sub === 'diff' && e.argv.includes('--no-index')) {
      // A new file's numstat: its lines, all added.
      const file = e.argv.at(-1) ?? ''
      const lines = (gh.patches?.[file] ?? '').split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length
      return ok(`${lines}\t0\t${file}\n`, lines > 0 ? 1 : 0)
    }
    if (cmd === 'git' && sub === 'diff') {
      if (gh.notRepo || (gh.noHead && e.argv.includes('HEAD'))) return ok('', 128)
      // Test data is written one `added\tdeleted\tpath` per line; git -z ends each with NUL.
      return ok(gh.numstatZ ?? (gh.numstat ?? '').split('\n').filter(Boolean).map(line => `${line}\0`).join(''))
    }
    if (cmd === 'git' && sub === 'ls-files') {
      // `--directory` would print a wholly new folder once, as `folder/`.
      const paths = (gh.untracked ?? '').split('\n').filter(Boolean)
      const listed = e.argv.includes('--directory') ? [...new Set(paths.map(path => path.replace(/\/[^/]+$/, '/')))] : paths
      return ok(listed.map(line => `${line}\0`).join(''))
    }
    calls.push([...e.argv])
    if (gh.error) return { value: { exitCode: 1, stdout: '', stderr: gh.error, isStdoutTruncated: false, isStderrTruncated: false } }
    const mine = gh.mine
    return ok(
      JSON.stringify({
        data: {
          viewer: { login: 'me' },
          merged: { nodes: gh.merged ?? [] },
          reviews: { issueCount: gh.reviews.filter(pr => !pr.isDraft).length, nodes: gh.reviews },
          assigned: { issueCount: (gh.assigned ?? []).length, nodes: gh.assigned ?? [] },
          // The search asks for draft:false, so GitHub's total leaves drafts out.
          mine: { issueCount: mine.filter(pr => !pr.isDraft).length, nodes: mine },
          reviewed: { nodes: gh.reviewed ?? [] },
        },
      }),
    )
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return calls
}

test('one gh call per refresh; flags new review requests and approvals', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [pr(1), pr(2), pr(5, null, 'SUCCESS', true)], mine: [pr(7), pr(8, null, 'FAILURE', true), pr(9, null, 'FAILURE')] }
  const calls = fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(calls.length).toBe(1)
  expect(calls[0]?.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(calls[0]?.join(' ')).toContain('draft:false review-requested:@me')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await ui.find({ type: 'Link', text: /Reviews 2$/ })).toBeDefined()
    // Drafts (#5 asks for my review, #8 is mine) are in no count; the one failing PR links straight to itself.
    expect(await ui.find({ type: 'Link', text: /My PRs 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'https://github.com/o/r/pull/9✗ CI 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: /Assigned/ })).toBeUndefined()
    await ui.unmount()
  }

  gh.reviews = [pr(1), pr(2), pr(3), pr(5, null, 'SUCCESS', true)]
  gh.assigned = [pr(30), { ...pr(31), author: { login: 'me' } }]
  gh.mine = [pr(7, 'APPROVED'), pr(8), pr(9, null, 'FAILURE')]
  await clock.advance(REFRESH_MS)
  expect(calls.length).toBe(2)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await ui.find({ type: 'Link', text: /Reviews 3 \(\+1 new\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Approved 1/ })).toBeDefined()
    expect(await hasNews(ui, /review requested #3/)).toBe(true)
    // A draft asking for review is no news either.
    expect(await hasNews(ui, /#5/)).toBe(false)
    expect(await hasNews(ui, /approved #7/)).toBe(true)
    // Self-assigned #31 counts but is no news.
    expect(await ui.find({ type: 'Link', text: /Assigned 2/ })).toBeDefined()
    expect(await hasNews(ui, /assigned #30/)).toBe(true)
    expect(await hasNews(ui, /assigned #31/)).toBe(false)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
  await ui.unmount()
})

test('rate limit shows a short message and pauses polling', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = {
    reviews: [],
    mine: [],
    error: 'gh: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  }
  const calls = fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^GitHub rate limit, retrying at/ })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()

  // Another session starting during the backoff does not fetch.
  await clock.advance(5 * 60 * 1000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(calls.length).toBe(1)

  // The next tick retries.
  gh.error = undefined
  await clock.advance(REFRESH_MS - 5 * 60 * 1000)
  expect(calls.length).toBe(2)
})

test('new comments on my PRs and replies on PRs I reviewed; mine and bots ignored', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = {
    reviews: [],
    mine: [withComments(pr(7), note('alice', '2026-10-14T08:00:00Z', 'https://github.com/o/r/pull/7#c1'))],
    reviewed: [withComments(pr(20))],
  }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  let ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
  await ui.unmount()

  // My own comment and a bot's are not news; bob's on my PR and carol's on the reviewed one are.
  gh.mine = [
    withComments(
      pr(7),
      note('alice', '2026-10-14T08:00:00Z', 'https://github.com/o/r/pull/7#c1'),
      note('me', '2026-10-14T09:00:00Z', 'https://github.com/o/r/pull/7#c2'),
      note('copilot', '2026-10-14T09:30:00Z', 'https://github.com/o/r/pull/7#c3', 'Bot'),
    ),
  ]
  gh.reviewed = [withComments(pr(20), note('carol', '2026-10-14T10:00:00Z', 'https://github.com/o/r/pull/20#c9'))]
  await clock.advance(REFRESH_MS)

  ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await hasNews(ui, /by me|by copilot/)).toBe(false)
  expect(await hasNews(ui, /^\[reply by carol #20/)).toBe(true)
  // One new comment: a link straight to it.
  expect(await ui.find({ type: 'Markdown', text: '[💬 1 new](https://github.com/o/r/pull/20#c9)' })).toBeDefined()
  await ui.unmount()

  gh.mine = [withComments(pr(7), note('bob', '2026-10-14T11:00:00Z', 'https://github.com/o/r/pull/7#c4'))]
  await clock.advance(REFRESH_MS)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await hasNews(band, /^\[comment by bob #7/)).toBe(true)
    // Several: a link to the repo's recently updated PRs.
    expect(await band.find({ type: 'Link', text: /involves%3A%40me.*💬 2 new/ })).toBeDefined()
    await band.unmount()
  }
})

test('scopes counts, links and query to the session repo; no GitHub remote means every repo', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [pr(1)], mine: [pr(7)], remote: 'git@github.com:acme/web.git' }
  const calls = fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(calls[0]?.join(' ')).toContain('repo:acme/web draft:false review-requested:@me')

  let ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /repo%3Aacme%2Fweb.*My PRs 1/ })).toBeDefined()
  await ui.unmount()

  gh.remote = null
  ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'refresh' })
  expect(calls.at(-1)?.join(' ')).not.toContain('repo:')
  expect(await ui.find({ type: 'Text', text: 'all repos' })).toBeDefined()
  await ui.unmount()
})

test('an approval is one item with its reviewer, not also a comment; a merge replaces the PR news', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const approval: Review = {
    author: { __typename: 'User', login: 'alex' },
    state: 'APPROVED',
    submittedAt: '2026-10-15T11:30:50Z',
    url: 'https://github.com/o/r/pull/7616#review-1',
  }
  const gh: Gh = { reviews: [], mine: [pr(7616)] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  gh.mine = [{ ...pr(7616, 'APPROVED'), reviews: { nodes: [approval] } }]
  await clock.advance(REFRESH_MS)

  let ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await hasNews(ui, /^\[approved by alex #7616/)).toBe(true)
  expect((await newsMatching(ui, /#7616 PR 7616/)).length).toBe(1)
  expect(await ui.find({ text: /💬/ })).toBeUndefined()
  await ui.unmount()

  gh.mine = []
  gh.merged = [pr(7616)]
  await clock.advance(REFRESH_MS)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await hasNews(band, /^\[merged #7616/)).toBe(true)
    expect((await newsMatching(band, /#7616 PR 7616/)).length).toBe(1)
    await band.unmount()
  }
  ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Link', text: /Approved/ })).toBeUndefined()
  await ui.unmount()
})

test('"+N more" opens GitHub at the repo PRs involving me, newest first', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [pr(1)], mine: [] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  gh.reviews = [pr(1), pr(2), pr(3), pr(4), pr(5), pr(6)]
  await clock.advance(REFRESH_MS)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    const more = await ui.find({ type: 'Link', text: /\+2 more$/ })
    expect(more?.text).toContain(`https://github.com/pulls?q=${encodeURIComponent('is:pr repo:o/r involves:@me sort:updated-desc')}`)
    await ui.unmount()
  }
})

test('clicking a news item opens it on GitHub and removes it from New', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  opened.length = 0
  const gh: Gh = { reviews: [], mine: [withComments(pr(7))] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  gh.reviews = [pr(3)]
  gh.mine = [withComments(pr(7), note('bob', '2026-10-14T11:00:00Z', 'https://github.com/o/r/pull/7#c4'))]
  await clock.advance(REFRESH_MS)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'news:comment:https://github.com/o/r/pull/7', link: { href: 'https://github.com/o/r/pull/7#c4' } })
  expect(opened).toEqual(['https://github.com/o/r/pull/7#c4'])
  expect(await hasNews(ui, /comment by bob/)).toBe(false)
  expect(await hasNews(ui, /review requested #3/)).toBe(true)
  expect(await ui.find({ text: /💬/ })).toBeUndefined()

  await ui.press({ key: 'news:review-requested:https://github.com/o/r/pull/3', link: { href: 'https://github.com/o/r/pull/3' } })
  expect(opened.at(-1)).toBe('https://github.com/o/r/pull/3')
  expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
  await ui.unmount()

  // Gone from the store too: the next refresh does not bring them back.
  await clock.advance(REFRESH_MS)
  const again = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await again.find({ type: 'Text', text: 'New:' })).toBeUndefined()
  await again.unmount()
})

test('each news item is one line cut to the band width', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  gh.reviews = [{ ...pr(3), title: 'x'.repeat(200) }]
  await clock.advance(REFRESH_MS)

  // Terminal: exact cells. Desktop: a proportional font fits ~1.3 characters per cell.
  for (const [surface, width] of [['terminal', 44], ['desktop', 59]] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND, props: { ...BAND.props, bodyColumns: 50 } })
    const [label] = (await newsMatching(ui, /review requested #3/)).map(text => /^\[(.*)\]\(/.exec(text)?.[1] ?? '')
    expect(label?.length).toBe(width)
    expect(label?.endsWith('…')).toBe(true)
    await ui.unmount()
  }
})

test('clicking the single new-comment count opens that comment and clears it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  opened.length = 0
  const gh: Gh = { reviews: [], mine: [withComments(pr(7))] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  gh.mine = [withComments(pr(7), note('bob', '2026-10-14T11:00:00Z', 'https://github.com/o/r/pull/7#c4'))]
  await clock.advance(REFRESH_MS)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'comments', link: { href: 'https://github.com/o/r/pull/7#c4' } })
  expect(opened).toEqual(['https://github.com/o/r/pull/7#c4'])
  expect(await ui.find({ text: /💬/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
  // The refresh and hide controls are still pressable.
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  await ui.unmount()
})

test('× after a news item removes it without opening it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  opened.length = 0
  const gh: Gh = { reviews: [], mine: [] }
  fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  gh.reviews = [pr(3), pr(4)]
  await clock.advance(REFRESH_MS)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await ui.find({ type: 'Button', key: 'drop:review-requested:https://github.com/o/r/pull/3' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'drop:review-requested:https://github.com/o/r/pull/3' })
  expect(opened).toEqual([])
  expect(await hasNews(ui, /review requested #3/)).toBe(false)
  expect(await hasNews(ui, /review requested #4/)).toBe(true)
  await ui.unmount()

  await clock.advance(REFRESH_MS)
  const again = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await hasNews(again, /review requested #3/)).toBe(false)
  await again.unmount()
})

test('Uncommitted lists changed files with +/- after edits, and folds', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [] }
  fakeGh(on, gh)
  // Stands in for the engine running the tool.
  on('tool.call', () => ({ result: {} as never }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  let ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ text: /Uncommitted/ })).toBeUndefined()
  await ui.unmount()

  gh.numstat = '12\t3\tsrc/a.ts\n1\t0\tsrc/deep/b.tsx\n-\t-\tlogo.png\n'
  gh.untracked = 'notes.md\n'
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /Uncommitted: 4 files/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '+13' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '−3' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'bin' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'new' })).toBeDefined()
    await band.unmount()
  }

  ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'changes' })
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▸ Uncommitted: 4 files/ })).toBeDefined()
  await ui.unmount()
})

const PANE = {
  component: 'Pane',
  requestId: 'uncommitted',
  props: { title: 'Uncommitted', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the Uncommitted pane lists every changed file; ⧉ on the band opens it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [], numstat: '', untracked: '' }
  fakeGh(on, gh)
  const opens: string[] = []
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  gh.numstat = '1\t0\tsrc/a.ts'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  // Changes alone open nothing: the pane waits for a click.
  expect(opens).toEqual([])
  gh.numstat = ''
  const first = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  await first.press({ key: 'pane-refresh' })
  await first.unmount()
  const empty = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  expect(await empty.find({ type: 'Text', text: 'No uncommitted changes' })).toBeDefined()
  await empty.unmount()

  gh.numstat = Array.from({ length: 8 }, (_, i) => `${i + 1}\t0\tsrc/f${i}.ts`).join('\n')
  const reread = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  await reread.press({ key: 'pane-refresh' })
  await reread.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: '8 files' })).toBeDefined()
    // All of them, where the band stops at 6.
    expect(await pane.find({ type: 'Text', text: 'src/f7.ts' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '+36' })).toBeDefined()
    await pane.unmount()
  }

  opens.length = 0
  const band = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await band.press({ key: 'changes-pane' })
  expect(opens).toEqual(['uncommitted'])
  // The band shows 6 of the 8; "+2 more" opens the pane, which lists them all.
  opens.length = 0
  expect((await band.find({ key: 'changes-more' }))?.text).toBe('+2 more')
  await band.press({ key: 'changes-more' })
  expect(opens).toEqual(['uncommitted'])
  await band.unmount()
})

const DESKTOP = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('a second session within the cache window reuses it: no second GitHub call', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const calls = fakeGh(on, { reviews: [pr(1)], mine: [] })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  await clock.advance(60 * 1000)
  await $.session.start(DESKTOP)
  await clock.advance(1)
  expect(calls.length).toBe(1)
})

test('a session starting during a rate-limit pause still draws the last data', async ($, on) => {
  const clock = mock.clock(on)
  const at = clock.now()
  // What another session left behind: an expired cache, and a pause running another 10 minutes.
  const totals = { reviews: 2, assigned: 0, mine: 0 }
  const data = { merged: [], reviews: [], assigned: [], mine: [], reviewed: [], totals }
  mock.store(on, { 'cache-v5:o/r': { at: at - REFRESH_MS, data }, backoffUntil: at + 10 * 60 * 1000 })
  const gh: Gh = { reviews: [pr(1), pr(2), pr(3)], mine: [] }
  const calls = fakeGh(on, gh)

  await $.session.start(DESKTOP)
  await clock.advance(1)
  expect(calls.length).toBe(0)
  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Link', text: /Reviews 2$/ })).toBeDefined()

  // ↻ fetches anyway; it succeeds and lifts the pause.
  await ui.press({ key: 'refresh' })
  expect(calls.length).toBe(1)
  expect(await ui.find({ type: 'Link', text: /Reviews 3$/ })).toBeDefined()
  await ui.unmount()
})

test('review-request news goes once the PR no longer asks for my review', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [] }
  fakeGh(on, gh)

  await $.session.start(DESKTOP)
  await clock.advance(1)
  gh.reviews = [pr(3), pr(4)]
  await clock.advance(REFRESH_MS)
  gh.reviews = [pr(4)]
  await clock.advance(REFRESH_MS)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await hasNews(ui, /review requested #3/)).toBe(false)
  expect(await hasNews(ui, /review requested #4/)).toBe(true)
  expect(await ui.find({ type: 'Link', text: /Reviews 1 \(\+1 new\)/ })).toBeDefined()
  await ui.unmount()
})

test('a -p run (not interactive) polls nothing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  on('process.run', ($, e) => {
    seen.push(e.argv[0] ?? '')
    return ok('')
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('tool.call', () => ({ result: {} as never }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  await clock.advance(REFRESH_MS * 2)
  expect(seen).toEqual([])
})

test('before the first commit, staged and untracked files still show; outside a repo nothing does', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [], noHead: true, numstat: '5\t0\tsrc/a.ts', untracked: 'notes/\n' }
  fakeGh(on, gh)
  on('tool.call', () => ({ result: {} as never }))

  await $.session.start(DESKTOP)
  await clock.advance(1)
  let ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Uncommitted: 2 files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'notes/' })).toBeDefined()
  await ui.unmount()

  gh.notRepo = true
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  await clock.advance(1)
  ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ text: /Uncommitted/ })).toBeUndefined()
  await ui.unmount()
})

test('a rename shows as old → new', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  fakeGh(on, { reviews: [], mine: [], numstatZ: '2\t1\t\0src/old.ts\0src/new.ts\0' })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'src/old.ts → src/new.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Uncommitted: 1 file$/ })).toBeDefined()
  await ui.unmount()
})

test('a news item stays when its link cannot be opened', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [], mine: [], openFails: true }
  fakeGh(on, gh)

  await $.session.start(DESKTOP)
  await clock.advance(1)
  gh.reviews = [pr(3)]
  await clock.advance(REFRESH_MS)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await ui.press({ key: 'news:review-requested:https://github.com/o/r/pull/3', link: { href: 'https://github.com/o/r/pull/3' } })
  expect(await hasNews(ui, /review requested #3/)).toBe(true)
  await ui.unmount()
})

test('without required reviews (no reviewDecision), an approving review still counts as Approved', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const approval: Review = {
    author: { __typename: 'User', login: 'alex' },
    state: 'APPROVED',
    submittedAt: '2026-10-15T11:30:50Z',
    url: 'https://github.com/o/r/pull/7#review-1',
  }
  fakeGh(on, { reviews: [], mine: [{ ...pr(7), reviews: { nodes: [approval] } }] })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Link', text: /Approved 1/ })).toBeDefined()
  await ui.unmount()
})

test('the desktop app (an SDK session: not interactive, no surface at start) polls once the band is drawn', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const calls = fakeGh(on, { reviews: [pr(1), pr(2)], mine: [] })

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(1)
  expect(calls.length).toBe(0)

  // The desktop draws the band (before any data): that starts polling.
  // Nothing to draw yet, so the hook hands the band back to the engine, which the kit has none of.
  await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND }).catch(() => undefined)
  await clock.advance(1)
  expect(calls.length).toBe(1)

  const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Link', text: /Reviews 2$/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(REFRESH_MS + 1)
  expect(calls.length).toBe(2)
})

const patchOf = (file: string, hunks: string) =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n${hunks}\n`

test('clicking a file in the pane shows its diff below it; clicking again hides it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  fakeGh(on, {
    reviews: [],
    mine: [],
    numstat: '1\t1\tsrc/a.ts',
    untracked: 'notes.md\n',
    patches: {
      'src/a.ts': patchOf('src/a.ts', '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3'),
      'notes.md': 'diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+hello',
    },
  })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...PANE })
    await pane.press({ key: 'diff:src/a.ts' })
    const codes = await pane.findAll({ type: 'Code' })
    if (surface === 'terminal') {
      // Hunks only: git's header lines are dropped so the diff parses.
      expect(codes.map(c => c.text)).toEqual(['@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3'])
    } else {
      // Runs of plain code, numbered: removed lines by the old file, the rest by the new.
      expect(codes.map(c => [c.text, c.props.startLine])).toEqual([['const a = 1', 1], ['const b = 2', 2], ['const b = 3', 2]])
    }
    for (const code of codes) {
      // Coloured as TypeScript, from the .ts extension.
      expect(code.props.language).toBe('typescript')
      // A long line is cut at the edge rather than wrapped back under the markers.
      expect(code.props.wrap).toBe('truncate-end')
    }
    await pane.press({ key: 'diff:notes.md' })
    expect((await pane.findAll({ type: 'Code' })).map(c => c.text)).toContain(surface === 'terminal' ? '@@ -0,0 +1 @@\n+hello' : 'hello')
    await pane.press({ key: 'diff:src/a.ts' })
    await pane.press({ key: 'diff:notes.md' })
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    await pane.unmount()
  }
})

test('clicking a file in the band opens the pane, wide, with its diff shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const opens: { id: string; columns?: number }[] = []
  on('ui.open', ($, e) => {
    opens.push({ id: e.id, columns: e.columns })
    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  fakeGh(on, {
    reviews: [],
    mine: [],
    numstat: '1\t0\tsrc/a.ts',
    patches: { 'src/a.ts': patchOf('src/a.ts', '@@ -1 +1,2 @@\n x\n+y') },
  })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  opens.length = 0
  const band = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  await band.press({ key: 'band-file:src/a.ts' })
  // Code needs more room than a file list: the pane asks for 100 columns.
  expect(opens).toEqual([{ id: 'uncommitted', columns: 100 }])
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  expect((await pane.findAll({ type: 'Code' })).map(c => c.text)).toEqual(['x', 'y'])
  await pane.unmount()
})

test('a long diff draws whole hunks up to the cap and counts the rest', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // Three hunks of 201 lines each (header + 200). Two would be 402 > 400, so only the first is kept.
  const hunk = (n: number) => [`@@ -${n},200 +${n},200 @@`, ...Array.from({ length: 200 }, (_, i) => ` line ${n + i}`)].join('\n')
  fakeGh(on, {
    reviews: [],
    mine: [],
    numstat: '3\t3\tbig.ts',
    patches: { 'big.ts': patchOf('big.ts', [hunk(1), hunk(1000), hunk(2000)].join('\n')) },
  })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  // The terminal draws the diff as one Code, so its lines are countable.
  const pane = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'terminal', ...PANE })
  await pane.press({ key: 'diff:big.ts' })
  const code = await pane.find({ type: 'Code' })
  expect(code?.text?.split('\n').length).toBe(201)
  expect(code?.text?.startsWith('@@ -1,200')).toBe(true)
  expect(await pane.find({ type: 'Text', text: '+402 more lines' })).toBeDefined()
  await pane.unmount()
})

test('diff colouring follows the file: PHP, Python, and no language for an unknown extension', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const hunk = '@@ -1 +1 @@\n-a\n+b'
  fakeGh(on, {
    reviews: [],
    mine: [],
    numstat: '1\t1\tapp/Http/User.php\n1\t1\ttools/run.py\n1\t1\tconfig.unknownext',
    patches: {
      'app/Http/User.php': patchOf('app/Http/User.php', hunk),
      'tools/run.py': patchOf('tools/run.py', hunk),
      'config.unknownext': patchOf('config.unknownext', hunk),
    },
  })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  const pane = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  for (const [file, language] of [
    ['app/Http/User.php', 'php'],
    ['tools/run.py', 'python'],
    ['config.unknownext', undefined],
  ] as const) {
    await pane.press({ key: `diff:${file}` })
    // One diff open at a time here, so the only Code is this file's.
    const code = await pane.find({ type: 'Code' })
    expect(code?.props.language).toBe(language)
    expect(code?.props.path).toBe(file)
    await pane.press({ key: `diff:${file}` })
  }
  await pane.unmount()
})

test('files in a new folder are listed one by one, not as the folder', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  fakeGh(on, { reviews: [], mine: [], numstat: '', untracked: 'src/evals/a.ts\nsrc/evals/b.ts\n' })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  const band = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: 'src/evals/a.ts' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'src/evals/b.ts' })).toBeDefined()
  expect(await band.find({ key: 'band-file:src/evals/' })).toBeUndefined()
  await band.unmount()
})

test('a new file counts its lines as added, in its row and the totals', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  fakeGh(on, {
    reviews: [],
    mine: [],
    numstat: '2\t1\tsrc/a.ts',
    untracked: 'ci.yml\n',
    patches: { 'ci.yml': 'diff --git a/ci.yml b/ci.yml\nnew file mode 100644\n--- /dev/null\n+++ b/ci.yml\n@@ -0,0 +1,3 @@\n+a\n+b\n+c' },
  })

  await $.session.start(DESKTOP)
  await clock.advance(1)
  const band = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Text', text: 'new +3' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '+5' })).toBeDefined()
  await band.unmount()
})
