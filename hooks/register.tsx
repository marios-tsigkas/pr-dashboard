import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Change, Counts, Diff, Pr, PrEvent, PrEventKind } from '../types'

const REFRESH_MS = 15 * 60 * 1000
// Sessions share one fetch through $.store; a cache younger than this is reused.
const CACHE_MS = REFRESH_MS - 15 * 1000
// Skips the fetch of any session that starts before the next tick; the tick itself retries.
const RATE_LIMIT_BACKOFF_MS = REFRESH_MS - 30 * 1000
// While one session fetches, others starting at the same moment wait for its result.
const LEASE_MS = 60 * 1000
const LEASE_RETRY_MS = 20 * 1000
const MAX_FRESH_SHOWN = 3
// News nobody clears is kept this long at most, newest first.
const MAX_FRESH_KEPT = 50
const MAX_CHANGES_SHOWN = 6
const MAX_CHANGES_IN_PANE = 200
// A diff draws whole hunks up to about this many lines; cut mid-hunk it would no longer parse.
const MAX_DIFF_LINES = 400
const CHANGES_PANE = { id: 'uncommitted', title: 'Uncommitted' }
const CHANGES_COMMAND = 'changes'
const KEYS = { cache: 'cache-v5', seen: 'seen', activity: 'activitySeen', fresh: 'fresh', lease: 'lease' }
// The rate limit is the GitHub user's, so its backoff is shared by every repo.
const BACKOFF_KEY = 'backoffUntil'
// Keys of earlier versions, removed once per session.
const isRetiredKey = (key: string) => /^(cache|cache-v[234]|seen|activitySeen|fresh)$/.test(key) || /^cache-v[234]:/.test(key)

// Each session follows the GitHub repo of its working directory (its `origin`); null means every repo.
type Repo = string | null

const resolveRepo = async ($: EngineInterface): Promise<Repo> => {
  const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  if (exitCode !== 0) return null
  const match = /(?:^|[@/])github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(stdout.trim())
  const repo = match?.[1] ?? null

  // Only a plain owner/name goes into search qualifiers.
  return repo !== null && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null
}

const keyFor = (key: string, repo: Repo) => `${key}:${repo ?? '*'}`
const repoQualifier = (repo: Repo) => (repo ? `repo:${repo} ` : '')
const scoped = (repo: Repo, q: string) => `is:open is:pr archived:false ${repoQualifier(repo)}${q}`
const MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const searchUrl = (q: string) => `https://github.com/pulls?q=${encodeURIComponent(q)}`
const linksFor = (repo: Repo) => ({
  reviews: searchUrl(scoped(repo, 'review-requested:@me')),
  mine: searchUrl(scoped(repo, 'author:@me draft:false')),
  failing: searchUrl(scoped(repo, 'author:@me draft:false status:failure')),
  approved: searchUrl(scoped(repo, 'author:@me draft:false review:approved')),
  changes: searchUrl(scoped(repo, 'author:@me draft:false review:changes-requested')),
  assigned: searchUrl(scoped(repo, 'assignee:@me draft:false')),
  // Merged PRs included and newest activity first, so the items past the shown few lead the list.
  recent: searchUrl(`is:pr ${repoQualifier(repo)}involves:@me sort:updated-desc`),
})
const LABELS: Record<PrEventKind, string> = {
  'review-requested': 'review requested',
  assigned: 'assigned',
  approved: 'approved',
  'changes-requested': 'changes requested',
  merged: 'merged',
  comment: 'comment',
  reply: 'reply',
}
// Kinds found by a PR entering a list; comments and replies are found by newer activity.
type ListKind = 'review-requested' | 'assigned' | 'approved' | 'changes-requested' | 'merged'
const LIST_KINDS: ListKind[] = ['review-requested', 'assigned', 'approved', 'changes-requested', 'merged']
// List news that goes stale once its PR leaves the list (a merge stays news).
const LIVE_KINDS = new Set<PrEventKind>(['review-requested', 'assigned', 'approved', 'changes-requested'])

// One GraphQL request (rate-limit cost ~20) instead of one REST search per count. The searches
// travel as variables, never spliced into the document.
const QUERY = `query($merged: String!, $reviews: String!, $assigned: String!, $mine: String!, $reviewed: String!) {
  viewer { login }
  merged: search(query: $merged, type: ISSUE, first: 20) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } } }
  }
  reviews: search(query: $reviews, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest { url title number repository { nameWithOwner } } }
  }
  assigned: search(query: $assigned, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest { url title number repository { nameWithOwner } author { login } } }
  }
  mine: search(query: $mine, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest { url title number repository { nameWithOwner } isDraft reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } ...Activity } }
  }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } ...Activity } }
  }
}
fragment Activity on PullRequest {
  comments(last: 3) { nodes { author { __typename login } createdAt url } }
  reviews(last: 3) { nodes { author { __typename login } state submittedAt url } }
  reviewThreads(last: 10) { nodes { comments(last: 1) { nodes { author { __typename login } createdAt url } } } }
}`

const searchesFor = (repo: Repo, since: string) => ({
  merged: `is:pr is:merged archived:false ${repoQualifier(repo)}author:@me merged:>=${since} sort:updated-desc`,
  reviews: scoped(repo, 'review-requested:@me'),
  assigned: scoped(repo, 'draft:false assignee:@me'),
  mine: scoped(repo, 'draft:false author:@me'),
  reviewed: scoped(repo, 'reviewed-by:@me -author:@me sort:updated-desc'),
})

type GhAuthor = { __typename: string; login: string } | null
type GhNote = { author: GhAuthor; createdAt?: string; submittedAt?: string | null; state?: string; url: string }
type GhPr = {
  url: string
  title: string
  number: number
  repository: { nameWithOwner: string }
  author?: { login: string } | null
  isDraft?: boolean
  reviewDecision?: string | null
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  comments?: { nodes: GhNote[] }
  reviews?: { nodes: GhNote[] }
  reviewThreads?: { nodes: { comments: { nodes: GhNote[] } }[] }
}
type GhSearch = { issueCount?: number; nodes: (GhPr | null)[] }
// The newest comment, review or thread reply on a PR by someone other than the viewer or a bot.
// `state` is a review's state (APPROVED, CHANGES_REQUESTED, COMMENTED); absent for a comment.
type Activity = { at: string; href: string; by: string; state?: string } | null
const REVIEW_VERBS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'review',
}
type WatchedPr = Pr & { activity: Activity }
type MinePr = WatchedPr & { decision: string | null; checks: string | null }
type AssignedPr = Pr & { isMine: boolean }
type Fetched = {
  merged: Pr[]
  reviews: Pr[]
  assigned: AssignedPr[]
  mine: MinePr[]
  reviewed: WatchedPr[]
  totals: { reviews: number; assigned: number; mine: number }
}
type Cache = { at: number; data: Fetched }
type Seen = Record<ListKind, string[]>
type ActivitySeen = Record<string, string>

const snapshot = atom({ plugin: 'pr-dashboard', key: 'snapshot' } as const, null)
const fresh = atom({ plugin: 'pr-dashboard', key: 'fresh' } as const, [])
const isHidden = atom({ plugin: 'pr-dashboard', key: 'isHidden' } as const, false)
const changes = atom({ plugin: 'pr-dashboard', key: 'changes' } as const, null)
const isChangesOpen = atom({ plugin: 'pr-dashboard', key: 'isChangesOpen' } as const, true)
const expanded = atom({ plugin: 'pr-dashboard', key: 'expanded' } as const, [])
const diffs = atom({ plugin: 'pr-dashboard', key: 'diffs' } as const, {})

const toPr = (pr: GhPr): Pr => ({
  url: pr.url,
  title: pr.title,
  number: pr.number,
  repo: pr.repository.nameWithOwner,
})

const isBot = (author: NonNullable<GhAuthor>) => author.__typename === 'Bot' || author.login.endsWith('[bot]')

const latestActivity = (pr: GhPr, me: string): Activity => {
  const notes = [
    ...(pr.comments?.nodes ?? []),
    ...(pr.reviews?.nodes ?? []),
    ...(pr.reviewThreads?.nodes.flatMap(thread => thread.comments.nodes) ?? []),
  ]
  let latest: Activity = null
  for (const note of notes) {
    const at = note.createdAt ?? note.submittedAt
    if (!at || !note.author || isBot(note.author) || note.author.login === me) continue
    if (latest === null || at > latest.at) {
      latest = { at, href: note.url, by: note.author.login, ...(note.state && { state: note.state }) }
    }
  }

  return latest
}

// reviewDecision is null when the repo requires no reviews; then the latest reviews decide
// (only the last three are fetched, so an older approval can be missed).
const decisionOf = (pr: GhPr): string | null => {
  if (pr.reviewDecision) return pr.reviewDecision
  const latestByReviewer = new Map<string, string>()
  for (const review of pr.reviews?.nodes ?? []) {
    if (review.author && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')) {
      latestByReviewer.set(review.author.login, review.state)
    }
  }
  const states = [...latestByReviewer.values()]
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'

  return states.includes('APPROVED') ? 'APPROVED' : null
}

const prsOf = (search: GhSearch | undefined) => (search?.nodes ?? []).filter((pr): pr is GhPr => Boolean(pr?.url))

const fetchPrs = async ($: EngineInterface, repo: Repo): Promise<Fetched> => {
  const since = new Date((await $.clock.now()) - MERGED_WINDOW_MS).toISOString().slice(0, 10)
  const variables = Object.entries(searchesFor(repo, since)).flatMap(([name, q]) => ['-f', `${name}=${q}`])
  const { exitCode, stdout, stderr } = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${QUERY}`, ...variables])
  if (exitCode !== 0) throw new Error(stderr.trim() || `gh exited ${exitCode}`)
  const { data } = JSON.parse(stdout) as {
    data?: {
      viewer: { login: string }
      merged?: GhSearch
      reviews?: GhSearch
      assigned?: GhSearch
      mine?: GhSearch
      reviewed?: GhSearch
    } | null
  }
  if (!data) throw new Error('GitHub returned no data')
  const me = data.viewer.login
  const mine = prsOf(data.mine).filter(pr => !pr.isDraft)
  const reviews = prsOf(data.reviews)
  const assigned = prsOf(data.assigned)

  return {
    merged: prsOf(data.merged).map(toPr),
    reviews: reviews.map(toPr),
    assigned: assigned.map(pr => ({ ...toPr(pr), isMine: pr.author?.login === me })),
    mine: mine.map(pr => ({
      ...toPr(pr),
      decision: decisionOf(pr),
      checks: pr.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      activity: latestActivity(pr, me),
    })),
    reviewed: prsOf(data.reviewed).map(pr => ({ ...toPr(pr), activity: latestActivity(pr, me) })),
    // GitHub's own totals: the lists above stop at their first page.
    totals: {
      reviews: data.reviews?.issueCount ?? reviews.length,
      assigned: data.assigned?.issueCount ?? assigned.length,
      mine: data.mine?.issueCount ?? mine.length,
    },
  }
}

const bucket = (data: Fetched): Record<ListKind, Pr[]> & { failing: Pr[] } => ({
  'review-requested': data.reviews,
  merged: data.merged,
  // Self-assigning a PR of one's own is counted but is no news.
  assigned: data.assigned.filter(pr => !pr.isMine),
  approved: data.mine.filter(pr => pr.decision === 'APPROVED'),
  'changes-requested': data.mine.filter(pr => pr.decision === 'CHANGES_REQUESTED'),
  failing: data.mine.filter(pr => pr.checks === 'FAILURE' || pr.checks === 'ERROR'),
})

// News found against what was seen last time, and the new baseline to write once the news is saved.
type Found = { events: PrEvent[]; save: () => Promise<void> }

// Diffs against the URLs seen last time (kept across sessions); the first run only records a baseline.
const findNew = async ($: EngineInterface, repo: Repo, current: Record<ListKind, Pr[]>): Promise<Found> => {
  const seen = (await $.store.get(keyFor(KEYS.seen, repo))) as Seen | undefined
  const next = Object.fromEntries(LIST_KINDS.map(kind => [kind, current[kind].map(pr => pr.url)]))
  const save = () => $.store.set(keyFor(KEYS.seen, repo), next)
  if (seen === undefined) return { events: [], save }

  return {
    events: LIST_KINDS.flatMap(kind =>
      current[kind].filter(pr => seen[kind] !== undefined && !seen[kind].includes(pr.url)).map(pr => ({ kind, pr })),
    ),
    save,
  }
}

// A PR seen before ('' = no activity then) whose newest activity is newer is a new comment.
// A PR seen for the first time only records its baseline.
const findActivity = async ($: EngineInterface, repo: Repo, data: Fetched): Promise<Found> => {
  const seen = ((await $.store.get(keyFor(KEYS.activity, repo))) as ActivitySeen | undefined) ?? {}
  const watched = [
    ...data.mine.map(pr => ({ kind: 'comment' as const, pr })),
    ...data.reviewed.map(pr => ({ kind: 'reply' as const, pr })),
  ]
  const next = Object.fromEntries(watched.map(({ pr }) => [pr.url, pr.activity?.at ?? '']))

  return {
    events: watched.flatMap(({ kind, pr: { activity, ...pr } }) => {
      const before = seen[pr.url]
      if (activity === null || before === undefined || activity.at <= before) return []

      return [{ kind, pr, href: activity.href, by: activity.by, ...(activity.state && { state: activity.state }) }]
    }),
    save: () => $.store.set(keyFor(KEYS.activity, repo), next),
  }
}

const STATE_OF_KIND: Partial<Record<PrEventKind, string>> = { approved: 'APPROVED', 'changes-requested': 'CHANGES_REQUESTED' }

// One item per happening: a merge replaces the PR's other news, and a review that moved the
// PR into approved / changes requested is that one item, carrying who did it.
const combine = (events: PrEvent[]): PrEvent[] => {
  const merged = new Set(events.filter(e => e.kind === 'merged').map(e => e.pr.url))
  const kept = events.filter(e => e.kind === 'merged' || !merged.has(e.pr.url))
  const reviewFor = (event: PrEvent) =>
    kept.find(e => e.kind === 'comment' && e.pr.url === event.pr.url && e.state === STATE_OF_KIND[event.kind])

  return kept.flatMap(event => {
    if (STATE_OF_KIND[event.kind]) {
      const review = reviewFor(event)
      return [review ? { ...event, href: review.href, by: review.by } : event]
    }
    const isCovered =
      event.kind === 'comment' &&
      kept.some(e => STATE_OF_KIND[e.kind] !== undefined && e.pr.url === event.pr.url && event.state === STATE_OF_KIND[e.kind])

    return isCovered ? [] : [event]
  })
}

// An approval or change request is not a comment, even when it arrives as activity.
const isComment = (event: PrEvent) =>
  (event.kind === 'comment' || event.kind === 'reply') && event.state !== 'APPROVED' && event.state !== 'CHANGES_REQUESTED'

const verbOf = (event: PrEvent) => (event.state ? REVIEW_VERBS[event.state] : undefined) ?? LABELS[event.kind]

const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

const shortError = (message: string, retryAt: number | null) => {
  if (/rate limit/i.test(message)) return `GitHub rate limit${retryAt === null ? '' : `, retrying at ${clockTime(retryAt)}`}`
  const line = message.split('\n')[0] ?? message

  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

// This session's next timer tick, so a rate-limit message names when it really retries.
let nextTickAt = 0

const readFresh = async ($: EngineInterface, repo: Repo) =>
  ((await $.store.get(keyFor(KEYS.fresh, repo))) as PrEvent[] | undefined) ?? []

const fetchAndDiff = async ($: EngineInterface, repo: Repo, now: number): Promise<Fetched> => {
  await $.store.set(keyFor(KEYS.lease, repo), now + LEASE_MS)
  try {
    const data = await fetchPrs($, repo)
    await $.store.set(keyFor(KEYS.cache, repo), { at: now, data } satisfies Cache)
    await $.store.delete(BACKOFF_KEY)
    const found = [await findNew($, repo, bucket(data)), await findActivity($, repo, data)]
    const events = combine(found.flatMap(f => f.events))
    if (events.length > 0) {
      const stored = await readFresh($, repo)
      await $.store.set(keyFor(KEYS.fresh, repo), [
        ...events,
        ...stored.filter(old => !events.some(e => e.pr.url === old.pr.url && (e.kind === old.kind || e.kind === 'merged'))),
      ])
      const [first] = events
      $.ui.toast(
        events.length === 1 && first
          ? `PR ${verbOf(first)}${first.by ? ` by ${first.by}` : ''}: #${first.pr.number} ${first.pr.title}`
          : `${events.length} PR updates`,
      )
    }
    // Baselines move only once the news they found is saved.
    for (const f of found) await f.save()

    return data
  } finally {
    await $.store.delete(keyFor(KEYS.lease, repo))
  }
}

const refresh = async ($: EngineInterface, { force = false } = {}) => {
  const now = await $.clock.now()
  let repo: Repo = null
  try {
    repo = await resolveRepo($)
    const cache = (await $.store.get(keyFor(KEYS.cache, repo))) as Cache | undefined
    const backoffUntil = Number((await $.store.get(BACKOFF_KEY)) ?? 0)
    const leaseUntil = Number((await $.store.get(keyFor(KEYS.lease, repo))) ?? 0)
    const isStale = cache === undefined || now - cache.at >= CACHE_MS
    let data = cache?.data
    let checkedAt = cache?.at ?? now
    if (force || (isStale && now >= backoffUntil && now >= leaseUntil)) {
      data = await fetchAndDiff($, repo, now)
      checkedAt = now
    } else if (isStale && now < leaseUntil) {
      // Another session is fetching: show its result once it lands.
      $.clock.after(LEASE_RETRY_MS, () => void refresh($))
    }
    // During a backoff or a lease this draws the last cache (or nothing yet); the fetch waits.
    if (data === undefined) return

    const buckets = bucket(data)
    const counts: Counts = {
      reviews: data.totals.reviews,
      assigned: data.totals.assigned,
      mine: data.totals.mine,
      failing: buckets.failing,
      approved: buckets.approved.length,
      changes: buckets['changes-requested'].length,
    }
    // News goes stale when its PR merged, or left the list that made it news (no longer requested,
    // assigned, approved...). The rest is kept newest first, up to a cap.
    const merged = new Set(data.merged.map(pr => pr.url))
    const stillListed = (event: PrEvent) =>
      !LIVE_KINDS.has(event.kind) || buckets[event.kind as ListKind].some(pr => pr.url === event.pr.url)
    const stored = await readFresh($, repo)
    const current = stored
      .filter(e => (e.kind === 'merged' || !merged.has(e.pr.url)) && stillListed(e))
      .slice(0, MAX_FRESH_KEPT)
    if (current.length !== stored.length) await $.store.set(keyFor(KEYS.fresh, repo), current)
    await update($, fresh, () => current)
    await update($, snapshot, () => ({ repo, counts, checkedAt }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isRateLimited = /rate limit/i.test(message)
    let retryAt: number | null = null
    if (isRateLimited) {
      const backoffUntil = now + RATE_LIMIT_BACKOFF_MS
      await $.store.set(BACKOFF_KEY, backoffUntil).catch(() => undefined)
      // The first tick of this session's timer at or after the backoff.
      retryAt = nextTickAt
      while (retryAt < backoffUntil) retryAt += REFRESH_MS
    }
    await update($, snapshot, prev => ({
      repo,
      counts: prev?.counts ?? null,
      checkedAt: prev?.checkedAt ?? now,
      error: shortError(message, retryAt),
    }))
  }
}

const dismiss = async ($: EngineInterface) => {
  const snap = await read($, snapshot)
  await $.store.set(keyFor(KEYS.fresh, snap?.repo ?? null), [])
  await update($, fresh, () => [])
}

const newsLabel = (event: PrEvent) =>
  `${verbOf(event)}${event.by ? ` by ${event.by}` : ''} #${event.pr.number} ${event.pr.title}`
// Keeps a path's end (the file name), cutting from the front.
const cutStart = (text: string, width: number) => (text.length > width ? `…${text.slice(text.length - width + 1)}` : text)
const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]()<>#|~]/g, ch => `\\${ch}`)

const isSame = (a: PrEvent, b: PrEvent) => a.kind === b.kind && a.pr.url === b.pr.url

const removeEvent = async ($: EngineInterface, event: PrEvent) => {
  const snap = await read($, snapshot)
  const key = keyFor(KEYS.fresh, snap?.repo ?? null)
  const stored = ((await $.store.get(key)) as PrEvent[] | undefined) ?? []
  await $.store.set(key, stored.filter(e => !isSame(e, event)))
  await update($, fresh, list => list.filter(e => !isSame(e, event)))
}

// Opens a GitHub URL in the host's browser: macOS `open`, else `xdg-open`.
const openUrl = async ($: EngineInterface, url: string) => {
  if (!url.startsWith('https://github.com/')) return false
  for (const opener of ['open', 'xdg-open']) {
    const run = await $.process.run([opener, url]).catch(() => null)
    if (run?.exitCode === 0) return true
  }

  return false
}

// The surface opens nothing for a link the plugin answers, so this opens it, and clears the item
// only once it opened.
const openEvent = async ($: EngineInterface, event: PrEvent) => {
  if (await openUrl($, event.href ?? event.pr.url)) await removeEvent($, event)
  else $.ui.toast(`Couldn't open ${event.href ?? event.pr.url}`)
}

// `git diff --numstat -z`: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`.
const parseNumstat = (out: string): Change[] => {
  const parts = out.split('\0')
  const list: Change[] = []
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (!record) continue
    const [added = '-', deleted = '-', path = ''] = record.split('\t')
    const name = path === '' ? `${parts[i + 1] ?? ''} → ${parts[i + 2] ?? ''}` : path
    if (path === '') i += 2
    list.push({
      path: name,
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
      isNew: false,
    })
  }

  return list
}

// Uncommitted work against HEAD (staged and unstaged) plus untracked files; local git only.
// Before the first commit there is no HEAD: staged files are then diffed against nothing.
const readChanges = async ($: EngineInterface): Promise<Change[] | null> => {
  const run = (argv: string[]) => $.process.run(argv).catch(() => null)
  let diff = await run(['git', 'diff', 'HEAD', '--numstat', '-z'])
  if (diff?.exitCode !== 0) {
    const inside = await run(['git', 'rev-parse', '--is-inside-work-tree'])
    if (inside?.exitCode !== 0) return null
    diff = await run(['git', 'diff', '--cached', '--numstat', '-z'])
  }
  const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z'])
  const tracked = diff?.exitCode === 0 ? parseNumstat(diff.stdout) : []
  const added = (untracked?.exitCode === 0 ? untracked.stdout.split('\0').filter(Boolean) : []).map(path => ({
    path,
    added: null,
    deleted: null,
    isNew: true,
  }))

  return [...tracked, ...added]
}

// A rename is listed as `old → new`.
const filesOf = (change: Change) => change.path.split(' → ')

// Highlighter language ids by file extension, named outright so a diff is coloured by its code.
// An extension not listed is left to the engine, which infers it from the path.
const LANGUAGES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  php: 'php', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
}
const languageOf = (file: string) => LANGUAGES[file.split('.').at(-1)?.toLowerCase() ?? '']

// Whole hunks from git's output (its header lines dropped), up to the line cap.
const toDiff = (out: string): Diff => {
  const start = out.startsWith('@@') ? 0 : out.indexOf('\n@@') + 1
  if (start === 0 && !out.startsWith('@@')) return { source: '', omittedLines: 0 }
  const hunks = out.slice(start).replace(/\n$/, '').split(/\n(?=@@ )/)
  const kept: string[] = []
  let lines = 0
  let omittedLines = 0
  for (const hunk of hunks) {
    const size = hunk.split('\n').length
    if (kept.length > 0 && lines + size > MAX_DIFF_LINES) omittedLines += size
    else {
      kept.push(hunk)
      lines += size
    }
  }

  return { source: kept.join('\n'), omittedLines }
}

const readDiff = async ($: EngineInterface, change: Change): Promise<Diff> => {
  const files = filesOf(change)
  const [file = change.path] = files.slice(-1)
  // A new folder is listed, not diffed.
  if (change.isNew && file.endsWith('/')) return { source: '', omittedLines: 0 }
  const run = (argv: string[]) => $.process.run(argv).catch(() => null)
  // `--` keeps a path from reading as an option. An untracked file diffs against nothing
  // (`--no-index` exits 1 when they differ); before the first commit there is no HEAD.
  const out = change.isNew
    ? await run(['git', 'diff', '--no-index', '--', '/dev/null', file])
    : await run(['git', 'diff', 'HEAD', '-M', '--', ...files])
  const text =
    out && (out.exitCode === 0 || (change.isNew && out.exitCode === 1))
      ? out.stdout
      : ((await run(['git', 'diff', '--cached', '-M', '--', ...files]))?.stdout ?? '')

  return toDiff(text)
}

// Re-reads every open diff, dropping those whose file is no longer changed.
const refreshDiffs = async ($: EngineInterface) => {
  const list = (await read($, changes)) ?? []
  const open = (await read($, expanded)).filter(path => list.some(c => c.path === path))
  const next: Record<string, Diff> = {}
  for (const path of open) {
    const change = list.find(c => c.path === path)
    if (change) next[path] = await readDiff($, change)
  }
  await update($, expanded, () => open)
  await update($, diffs, () => next)
}

const showDiff = async ($: EngineInterface, change: Change) => {
  const diff = await readDiff($, change)
  await update($, diffs, all => ({ ...all, [change.path]: diff }))
  await update($, expanded, open => (open.includes(change.path) ? open : [...open, change.path]))
  await openChangesPane($, { isWide: true })
}

const toggleDiff = async ($: EngineInterface, change: Change) => {
  if ((await read($, expanded)).includes(change.path)) {
    await update($, expanded, open => open.filter(path => path !== change.path))
  } else await showDiff($, change)
}

// One read at a time; a request while one runs reruns once after it, so the last read wins in order.
let isReading = false
let isRerunWanted = false
const refreshChanges = async ($: EngineInterface): Promise<void> => {
  if (isReading) {
    isRerunWanted = true
    return
  }
  isReading = true
  try {
    const list = await readChanges($)
    await update($, changes, () => list)
    await refreshDiffs($)
  } finally {
    isReading = false
  }
  if (isRerunWanted) {
    isRerunWanted = false
    await refreshChanges($)
  }
}

const totalsOf = (list: readonly Change[]) => ({
  added: list.reduce((sum, c) => sum + (c.added ?? 0), 0),
  deleted: list.reduce((sum, c) => sum + (c.deleted ?? 0), 0),
})

// Docked beside the transcript, a pane showing code asks for more room than a file list needs.
const DIFF_PANE_COLUMNS = 100
const openChangesPane = ($: EngineInterface, { isWide = false } = {}) =>
  $.ui.open({ ...CHANGES_PANE, ...(isWide && { columns: DIFF_PANE_COLUMNS }) }).catch(() => undefined)

type ChangeStatProps = {
  change: Change
  Box: Elements['terminal']['Box'] | Elements['desktop']['Box'] | Elements['vscode']['Box'] | Elements['mobile']['Box']
  Text: Elements['terminal']['Text'] | Elements['desktop']['Text'] | Elements['vscode']['Text'] | Elements['mobile']['Text']
}

// A file's +/- (or new / bin), shared by the band and the pane.
const ChangeStat = ({ change, Box, Text }: ChangeStatProps) =>
  change.isNew ? (
    <Text color="diffAdded" size="caption">new</Text>
  ) : change.added === null ? (
    <Text dimColor size="caption">bin</Text>
  ) : (
    <Box flexShrink={0} columnGap={1}>
      <Text color="diffAdded" size="caption">+{change.added}</Text>
      <Text color="diffRemoved" size="caption">−{change.deleted}</Text>
    </Box>
  )

// Tools that can change the working tree; the turn's end catches anything else.
const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash'])
// Polling starts once something draws: at session start under the terminal REPL, else on the
// first band draw (the desktop app runs sessions through the SDK, which reports no surface at
// start). A `-p` run never draws, so it never polls.
let isStarted = false

const start = async ($: EngineInterface) => {
  if (isStarted) return
  isStarted = true
  nextTickAt = (await $.clock.now()) + REFRESH_MS
  $.clock.every(REFRESH_MS, () => {
    nextTickAt += REFRESH_MS
    void refresh($)
  })
  void refresh($)
  void refreshChanges($).then(async () => {
    // Unasked, the surface places it only with room for a sidebar; /changes or ⧉ always does.
    if (((await read($, changes)) ?? []).length > 0) void openChangesPane($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (e.isInteractive) await start($)
    void $.store
      .keys()
      .then(keys => Promise.all(keys.filter(isRetiredKey).map(key => $.store.delete(key))))
      .catch(() => undefined)
    // A refused registration must not cost the session its pane and polling.
    await $.command.register({ name: CHANGES_COMMAND, description: 'Show uncommitted changes in a side pane' }).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: CHANGES_COMMAND }, async $ => {
    await refreshChanges($)
    await openChangesPane($)

    return { text: 'Opened the Uncommitted pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE.id }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const changed = await read($, changes)
    const open = await read($, expanded)
    const diffOf = await read($, diffs)
    const width = Math.max(20, Math.floor(e.props.bodyColumns * (e.surface === 'terminal' ? 1 : 1.3)) - 10)
    const { added, deleted } = totalsOf(changed ?? [])

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>
            {changed === null
              ? 'Not a git repository'
              : changed.length === 0
                ? 'No uncommitted changes'
                : `${changed.length} ${changed.length === 1 ? 'file' : 'files'}`}
          </Text>
          {changed !== null && changed.length > 0 && (
            <Box flexShrink={0} columnGap={1}>
              <Text color="diffAdded">+{added}</Text>
              <Text color="diffRemoved">−{deleted}</Text>
            </Box>
          )}
          <Button key="pane-refresh" plain onPress={() => void refreshChanges($)}>
            <Text dimColor size="caption">↻</Text>
          </Button>
        </Box>
        {(changed ?? []).slice(0, MAX_CHANGES_IN_PANE).map(change => {
          const isExpanded = open.includes(change.path)
          const diff = diffOf[change.path]
          return (
            // An open file is a framed card, set apart from its neighbours.
            <Box
              key={`pane:${change.path}`}
              flexDirection="column"
              {...(isExpanded && { borderStyle: 'round', borderDimColor: true, paddingX: 1, marginY: 1 })}
            >
              <Box flexDirection="row" columnGap={1}>
                <ChangeStat change={change} Box={Box} Text={Text} />
                {/* Clicking a file shows or hides its diff below it. */}
                <Button key={`diff:${change.path}`} plain onPress={() => void toggleDiff($, change)}>
                  {isExpanded ? (
                    <Text weight="semibold">▾ {cutStart(change.path, width - 6)}</Text>
                  ) : (
                    <Text dimColor size="caption">▸ {cutStart(change.path, width - 2)}</Text>
                  )}
                </Button>
              </Box>
              {isExpanded && diff && diff.source !== '' && (
                // Long lines wrap under the gutter; tokens are coloured by the (new) file's language.
                <Code
                  key={`code:${change.path}`}
                  source={diff.source}
                  format="diff"
                  path={filesOf(change).at(-1) ?? change.path}
                  {...(languageOf(filesOf(change).at(-1) ?? change.path) && {
                    language: languageOf(filesOf(change).at(-1) ?? change.path),
                  })}
                />
              )}
              {isExpanded && diff && diff.source === '' && (
                <Text dimColor size="caption">No text diff (binary, or a new folder)</Text>
              )}
              {isExpanded && diff && diff.omittedLines > 0 && (
                <Text dimColor size="caption">+{diff.omittedLines} more lines</Text>
              )}
            </Box>
          )
        })}
        {(changed ?? []).length > MAX_CHANGES_IN_PANE && (
          <Text dimColor size="caption">+{(changed ?? []).length - MAX_CHANGES_IN_PANE} more</Text>
        )}
      </Box>
    )
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (isStarted && WRITING_TOOLS.has(String(e.tool))) void refreshChanges($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (isStarted) void refreshChanges($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A surface is drawing: start polling, from a timer since a draw may not write state.
    if (!isStarted) $.clock.after(0, () => void start($))
    const snap = await read($, snapshot)
    const changed = (await read($, changes)) ?? []
    // Uncommitted shows on its own while the PR data is still on its way.
    if (e.props.hasSurvey || (snap === null && changed.length === 0)) return next(e)

    const isPrsHidden = await read($, isHidden)
    const events = snap ? await read($, fresh) : []
    const newReviews = events.filter(event => event.kind === 'review-requested').length
    const commentEvents = events.filter(isComment)
    const [firstComment] = commentEvents
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    // One line per item, cut to the band's width. bodyColumns counts terminal cells; other surfaces
    // draw a proportional font that fits about 1.3 characters per cell (measured on the desktop app).
    const charsPerCell = e.surface === 'terminal' ? 1 : 1.3
    const itemWidth = Math.max(20, Math.floor(e.props.bodyColumns * charsPerCell) - 6)
    const counts = snap?.counts ?? null
    const LINKS = linksFor(snap?.repo ?? null)
    const isOpen = await read($, isChangesOpen)
    const { added, deleted } = totalsOf(changed)

    return (
      <Box flexDirection="column">
        {snap && isPrsHidden && (
          <Button key="show" plain onPress={() => update($, isHidden, () => false)}>
            <Text dimColor size="caption">▸ PRs</Text>
          </Button>
        )}
        {snap && !isPrsHidden && (
          // Items keep their width and wrap as a whole onto the next line rather than breaking.
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Box flexShrink={0}>
              <Text dimColor>{snap.repo ? snap.repo.split('/')[1] : 'all repos'}</Text>
            </Box>
            {counts && (
              <Box flexShrink={0}>
                <Link href={LINKS.reviews}>
                  {newReviews > 0 ? `● Reviews ${counts.reviews} (+${newReviews} new)` : `Reviews ${counts.reviews}`}
                </Link>
              </Box>
            )}
            {counts && (
              <Box flexShrink={0}>
                <Link href={LINKS.mine}>My PRs {counts.mine}</Link>
              </Box>
            )}
            {counts && counts.assigned > 0 && (
              <Box flexShrink={0}>
                <Link href={LINKS.assigned}>⇢ Assigned {counts.assigned}</Link>
              </Box>
            )}
            {counts && counts.approved > 0 && (
              <Box flexShrink={0}>
                <Link href={LINKS.approved}>✓ Approved {counts.approved}</Link>
              </Box>
            )}
            {counts && counts.changes > 0 && (
              <Box flexShrink={0}>
                <Link href={LINKS.changes}>✎ Changes {counts.changes}</Link>
              </Box>
            )}
            {counts && counts.failing.length > 0 && (
              <Box flexShrink={0}>
                {/* One failing PR opens directly; GitHub's status search can lag behind the PR itself. */}
                <Link href={counts.failing.length === 1 ? (counts.failing[0]?.url ?? LINKS.failing) : LINKS.failing}>
                  ✗ CI {counts.failing.length}
                </Link>
              </Box>
            )}
            {firstComment && commentEvents.length === 1 && (
              <Box flexShrink={0}>
                <Markdown
                  key="comments"
                  text={`[💬 1 new](${firstComment.href ?? firstComment.pr.url})`}
                  pressableLinks={[firstComment.href ?? firstComment.pr.url]}
                  onLinkPress={() => void openEvent($, firstComment)}
                />
              </Box>
            )}
            {commentEvents.length > 1 && (
              <Box flexShrink={0}>
                <Link href={LINKS.recent}>💬 {commentEvents.length} new</Link>
              </Box>
            )}
            <Box flexShrink={0}>
              {/* A clock time: the band redraws on new data, not every minute, so "Nm ago" would go stale. */}
              <Text dimColor size="caption">{snap.error ?? `at ${clockTime(snap.checkedAt)}`}</Text>
            </Box>
            <Box flexShrink={0} columnGap={1}>
              <Button key="refresh" plain onPress={() => void refresh($, { force: true })}>
                <Text dimColor size="caption">↻</Text>
              </Button>
              <Button key="hide" plain onPress={() => update($, isHidden, () => true)}>
                <Text dimColor size="caption">hide</Text>
              </Button>
            </Box>
          </Box>
        )}
        {!isPrsHidden && events.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={2}>
              <Text dimColor>New:</Text>
              {events.length > MAX_FRESH_SHOWN && (
                <Link href={LINKS.recent}>+{events.length - MAX_FRESH_SHOWN} more</Link>
              )}
              <Button key="dismiss" plain label="dismiss" onPress={() => void dismiss($)} />
            </Box>
            {events.slice(0, MAX_FRESH_SHOWN).map(event => {
              const href = event.href ?? event.pr.url
              // A Markdown link is a real link that also reports the press, so a click can clear it.
              const id = `${event.kind}:${event.pr.url}`
              return (
                <Box key={`row:${id}`} flexDirection="row" columnGap={1}>
                  <Markdown
                    key={`news:${id}`}
                    text={`[${escapeMarkdown(cut(newsLabel(event), itemWidth))}](${href})`}
                    pressableLinks={[href]}
                    onLinkPress={() => void openEvent($, event)}
                  />
                  <Button key={`drop:${id}`} plain onPress={() => void removeEvent($, event)}>
                    <Text dimColor size="caption">×</Text>
                  </Button>
                </Box>
              )
            })}
          </Box>
        )}
        {changed.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Button key="changes" plain onPress={() => update($, isChangesOpen, open => !open)}>
                <Text dimColor>
                  {isOpen ? '▾' : '▸'} Uncommitted: {changed.length} {changed.length === 1 ? 'file' : 'files'}
                </Text>
              </Button>
              <Box flexShrink={0} columnGap={1}>
                <Text color="diffAdded">+{added}</Text>
                <Text color="diffRemoved">−{deleted}</Text>
              </Box>
              <Button key="changes-pane" plain onPress={() => void openChangesPane($)}>
                <Text dimColor size="caption">⧉</Text>
              </Button>
            </Box>
            {isOpen &&
              changed.slice(0, MAX_CHANGES_SHOWN).map(change => (
                <Box key={`change:${change.path}`} flexDirection="row" columnGap={1}>
                  <ChangeStat change={change} Box={Box} Text={Text} />
                  {/* Opens the pane with this file's diff shown. */}
                  <Button
                    key={`band-file:${change.path}`}
                    plain
                    onPress={() => void showDiff($, change)}
                  >
                    <Text dimColor size="caption">{cutStart(change.path, itemWidth - 10)}</Text>
                  </Button>
                </Box>
              ))}
            {isOpen && changed.length > MAX_CHANGES_SHOWN && (
              <Text dimColor size="caption">+{changed.length - MAX_CHANGES_SHOWN} more</Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
