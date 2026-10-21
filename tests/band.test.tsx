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
  untracked?: string
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

const fakeGh = (on: On, gh: Gh) => {
  const calls: string[][] = []
  on('process.run', ($, e) => {
    if (e.argv[0] === 'open') {
      opened.push(e.argv[1] ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git' && e.argv[1] !== 'remote') {
      const stdout = e.argv[1] === 'diff' ? (gh.numstat ?? '') : (gh.untracked ?? '')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git') {
      const remote = gh.remote === undefined ? 'https://github.com/o/r.git' : gh.remote
      const value = remote === null ? { exitCode: 2, stdout: '', stderr: 'no origin' } : { exitCode: 0, stdout: `${remote}\n`, stderr: '' }
      return { value: { ...value, isStdoutTruncated: false, isStderrTruncated: false } }
    }
    calls.push([...e.argv])
    const value = gh.error
      ? { exitCode: 1, stdout: '', stderr: gh.error }
      : { exitCode: 0, stdout: JSON.stringify({
          data: { viewer: { login: 'me' }, merged: { nodes: gh.merged ?? [] }, reviews: { nodes: gh.reviews }, assigned: { nodes: gh.assigned ?? [] }, mine: { nodes: gh.mine }, reviewed: { nodes: gh.reviewed ?? [] } },
        }), stderr: '' }
    return { value: { ...value, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return calls
}

test('one gh call per refresh; flags new review requests and approvals', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const gh: Gh = { reviews: [pr(1), pr(2)], mine: [pr(7), pr(8, null, 'FAILURE', true), pr(9, null, 'FAILURE')] }
  const calls = fakeGh(on, gh)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(calls.length).toBe(1)
  expect(calls[0]?.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await ui.find({ type: 'Link', text: /Reviews 2$/ })).toBeDefined()
    // The draft (#8) is in no count; the one failing PR links straight to itself.
    expect(await ui.find({ type: 'Link', text: /My PRs 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'https://github.com/o/r/pull/9✗ CI 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'New:' })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: /Assigned/ })).toBeUndefined()
    await ui.unmount()
  }

  gh.reviews = [pr(1), pr(2), pr(3)]
  gh.assigned = [pr(30), { ...pr(31), author: { login: 'me' } }]
  gh.mine = [pr(7, 'APPROVED'), pr(8), pr(9, null, 'FAILURE')]
  await clock.advance(REFRESH_MS)
  expect(calls.length).toBe(2)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-dashboard', surface, ...BAND })
    expect(await ui.find({ type: 'Link', text: /Reviews 3 \(\+1 new\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Approved 1/ })).toBeDefined()
    expect(await hasNews(ui, /review requested #3/)).toBe(true)
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
  expect(calls[0]?.join(' ')).toContain('repo:acme/web review-requested:@me')

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

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const empty = await $.ui.mount({ plugin: 'pr-dashboard', surface: 'desktop', ...PANE })
  expect(await empty.find({ type: 'Text', text: 'No uncommitted changes' })).toBeDefined()
  await empty.unmount()

  gh.numstat = Array.from({ length: 8 }, (_, i) => `${i + 1}\t0\tsrc/f${i}.ts`).join('\n')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

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
  await band.unmount()
})
