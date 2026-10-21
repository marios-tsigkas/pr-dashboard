import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Change, Counts, Pr, PrEvent, PrEventKind } from '../types'

const REFRESH_MS = 15 * 60 * 1000
// Sessions share one fetch through $.store; a cache younger than this is reused.
const CACHE_MS = REFRESH_MS - 15 * 1000
// Skips the fetch of any session that starts before the next tick; the tick itself retries.
const RATE_LIMIT_BACKOFF_MS = REFRESH_MS - 30 * 1000
const MAX_FRESH_SHOWN = 3
const MAX_CHANGES_SHOWN = 6
const CHANGES_PANE = 'uncommitted'
const CHANGES_COMMAND = 'changes'
const KEYS = { cache: 'cache-v4', seen: 'seen', activity: 'activitySeen', fresh: 'fresh' }
// The rate limit is the GitHub user's, so its backoff is shared by every repo.
const BACKOFF_KEY = 'backoffUntil'

// Each session follows the GitHub repo of its working directory (its `origin`); null means every repo.
type Repo = string | null

const resolveRepo = async ($: EngineInterface): Promise<Repo> => {
  const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'])
  if (exitCode !== 0) return null
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(stdout.trim())

  return match?.[1] ?? null
}

const keyFor = (key: string, repo: Repo) => `${key}:${repo ?? '*'}`
const scoped = (repo: Repo, q: string) => `is:open is:pr archived:false ${repo ? `repo:${repo} ` : ''}${q}`
const MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const mergedSince = (repo: Repo, since: string) =>
  `is:pr is:merged archived:false ${repo ? `repo:${repo} ` : ''}author:@me merged:>=${since}`
const search = (repo: Repo, q: string) => `https://github.com/pulls?q=${encodeURIComponent(scoped(repo, q))}`
const linksFor = (repo: Repo) => ({
  reviews: search(repo, 'review-requested:@me'),
  mine: search(repo, 'author:@me draft:false'),
  failing: search(repo, 'author:@me draft:false status:failure'),
  approved: search(repo, 'author:@me draft:false review:approved'),
  changes: search(repo, 'author:@me draft:false review:changes-requested'),
  assigned: search(repo, 'assignee:@me draft:false'),
  // Merged PRs included and newest activity first, so the items past the shown few lead the list.
  recent: `https://github.com/pulls?q=${encodeURIComponent(`is:pr ${repo ? `repo:${repo} ` : ''}involves:@me sort:updated-desc`)}`,
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

// One GraphQL request (rate-limit cost ~20) instead of one REST search per count.
const queryFor = (repo: Repo, since: string) => `query {
  merged: search(query: "${mergedSince(repo, since)}", type: ISSUE, first: 20) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } } }
  }
  viewer { login }
  reviews: search(query: "${scoped(repo, 'review-requested:@me')}", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } } }
  }
  assigned: search(query: "${scoped(repo, 'draft:false assignee:@me')}", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } author { login } } }
  }
  mine: search(query: "${scoped(repo, 'author:@me')}", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } isDraft reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } ...Activity } }
  }
  reviewed: search(query: "${scoped(repo, 'reviewed-by:@me -author:@me')}", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { url title number repository { nameWithOwner } ...Activity } }
  }
}
fragment Activity on PullRequest {
  comments(last: 3) { nodes { author { __typename login } createdAt url } }
  reviews(last: 3) { nodes { author { __typename login } state submittedAt url } }
  reviewThreads(last: 10) { nodes { comments(last: 1) { nodes { author { __typename login } createdAt url } } } }
}`

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
// The newest comment, review or thread reply on a PR by someone other than the viewer or a bot.
// `verb` is set for a review: what its state says, in place of the generic comment / reply label.
type Activity = { at: string; href: string; by: string; verb?: string } | null
const REVIEW_VERBS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'review',
}
type WatchedPr = Pr & { activity: Activity }
type MinePr = WatchedPr & { isDraft: boolean; decision: string | null; checks: string | null }
type AssignedPr = Pr & { isMine: boolean }
type Fetched = { merged: Pr[]; reviews: Pr[]; assigned: AssignedPr[]; mine: MinePr[]; reviewed: WatchedPr[] }
type Cache = { at: number; data: Fetched }
type Seen = Record<ListKind, string[]>
type ActivitySeen = Record<string, string>

const snapshot = atom({ plugin: 'pr-dashboard', key: 'snapshot' } as const, null)
const fresh = atom({ plugin: 'pr-dashboard', key: 'fresh' } as const, [])
const isHidden = atom({ plugin: 'pr-dashboard', key: 'isHidden' } as const, false)
const changes = atom({ plugin: 'pr-dashboard', key: 'changes' } as const, null)
const isChangesOpen = atom({ plugin: 'pr-dashboard', key: 'isChangesOpen' } as const, true)

const toPr = (pr: GhPr): Pr => ({
  url: pr.url,
  title: pr.title,
  number: pr.number,
  repo: pr.repository.nameWithOwner,
})

const latestActivity = (pr: GhPr, me: string): Activity => {
  const notes = [
    ...(pr.comments?.nodes ?? []),
    ...(pr.reviews?.nodes ?? []),
    ...(pr.reviewThreads?.nodes.flatMap(thread => thread.comments.nodes) ?? []),
  ]
  let latest: Activity = null
  for (const note of notes) {
    const at = note.createdAt ?? note.submittedAt
    if (!at || !note.author || note.author.__typename === 'Bot' || note.author.login === me) continue
    if (latest === null || at > latest.at) {
      const verb = note.state ? REVIEW_VERBS[note.state] : undefined
      latest = { at, href: note.url, by: note.author.login, ...(verb && { verb }) }
    }
  }

  return latest
}

const fetchPrs = async ($: EngineInterface, repo: Repo): Promise<Fetched> => {
  const since = new Date((await $.clock.now()) - MERGED_WINDOW_MS).toISOString().slice(0, 10)
  const { exitCode, stdout, stderr } = await $.process.run([
    'gh', 'api', 'graphql', '-f', `query=${queryFor(repo, since)}`,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `gh exited ${exitCode}`)
  const { data } = JSON.parse(stdout) as {
    data: {
      viewer: { login: string }
      merged: { nodes: GhPr[] }
      reviews: { nodes: GhPr[] }
      assigned: { nodes: GhPr[] }
      mine: { nodes: GhPr[] }
      reviewed: { nodes: GhPr[] }
    }
  }
  const me = data.viewer.login

  return {
    merged: data.merged.nodes.filter(pr => pr.url).map(toPr),
    reviews: data.reviews.nodes.filter(pr => pr.url).map(toPr),
    assigned: data.assigned.nodes
      .filter(pr => pr.url)
      .map(pr => ({ ...toPr(pr), isMine: pr.author?.login === me })),
    // Drafts are left out of every count on the person's own PRs.
    mine: data.mine.nodes.filter(pr => pr.url && !pr.isDraft).map(pr => ({
      ...toPr(pr),
      isDraft: pr.isDraft ?? false,
      decision: pr.reviewDecision ?? null,
      checks: pr.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      activity: latestActivity(pr, me),
    })),
    reviewed: data.reviewed.nodes
      .filter(pr => pr.url)
      .map(pr => ({ ...toPr(pr), activity: latestActivity(pr, me) })),
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

// Diffs against the URLs seen last time (kept across sessions); the first run only records a baseline.
const findNew = async ($: EngineInterface, repo: Repo, current: Record<ListKind, Pr[]>): Promise<PrEvent[]> => {
  const seen = (await $.store.get(keyFor(KEYS.seen, repo))) as Seen | undefined
  await $.store.set(keyFor(KEYS.seen, repo), Object.fromEntries(LIST_KINDS.map(kind => [kind, current[kind].map(pr => pr.url)])))
  if (seen === undefined) return []

  return LIST_KINDS.flatMap(kind =>
    current[kind].filter(pr => seen[kind] !== undefined && !seen[kind].includes(pr.url)).map(pr => ({ kind, pr })),
  )
}

// A PR seen before ('' = no activity then) whose newest activity is newer is a new comment.
// A PR seen for the first time only records its baseline.
const findActivity = async ($: EngineInterface, repo: Repo, data: Fetched): Promise<PrEvent[]> => {
  const seen = ((await $.store.get(keyFor(KEYS.activity, repo))) as ActivitySeen | undefined) ?? {}
  const watched = [
    ...data.mine.map(pr => ({ kind: 'comment' as const, pr })),
    ...data.reviewed.map(pr => ({ kind: 'reply' as const, pr })),
  ]
  await $.store.set(keyFor(KEYS.activity, repo), Object.fromEntries(watched.map(({ pr }) => [pr.url, pr.activity?.at ?? ''])))

  return watched.flatMap(({ kind, pr: { activity, ...pr } }) => {
    const before = seen[pr.url]
    if (activity === null || before === undefined || activity.at <= before) return []

    return [{ kind, pr, href: activity.href, by: activity.by, ...(activity.verb && { verb: activity.verb }) }]
  })
}

// One item per happening: a merge replaces the PR's other news, and a review that moved the
// PR into approved / changes requested is that one item, carrying who did it.
const combine = (events: PrEvent[]): PrEvent[] => {
  const merged = new Set(events.filter(e => e.kind === 'merged').map(e => e.pr.url))
  const kept = events.filter(e => e.kind === 'merged' || !merged.has(e.pr.url))

  return kept.flatMap(event => {
    if (event.kind === 'approved' || event.kind === 'changes-requested') {
      const review = kept.find(e => e.kind === 'comment' && e.pr.url === event.pr.url && e.verb === LABELS[event.kind])
      return [review ? { ...event, href: review.href, by: review.by } : event]
    }
    const isCovered = event.kind === 'comment' && kept.some(
      e => (e.kind === 'approved' || e.kind === 'changes-requested') && e.pr.url === event.pr.url && event.verb === LABELS[e.kind],
    )

    return isCovered ? [] : [event]
  })
}

// An approval or change request is not a comment, even when it arrives as activity.
const isComment = (event: PrEvent) =>
  (event.kind === 'comment' || event.kind === 'reply') && event.verb !== 'approved' && event.verb !== 'changes requested'

const shortError = (message: string, retryAt: number | null) => {
  if (/rate limit/i.test(message)) {
    const at = retryAt === null ? '' : `, retrying at ${new Date(retryAt).toTimeString().slice(0, 5)}`
    return `GitHub rate limit${at}`
  }
  const line = message.split('\n')[0] ?? message

  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

const refresh = async ($: EngineInterface, { force = false } = {}) => {
  const now = await $.clock.now()
  const backoffUntil = Number((await $.store.get(BACKOFF_KEY)) ?? 0)
  if (!force && now < backoffUntil) return
  const repo = await resolveRepo($)

  try {
    const cache = (await $.store.get(keyFor(KEYS.cache, repo))) as Cache | undefined
    let data = cache?.data
    let checkedAt = cache?.at ?? now
    if (force || cache === undefined || now - cache.at >= CACHE_MS) {
      data = await fetchPrs($, repo)
      checkedAt = now
      await $.store.set(keyFor(KEYS.cache, repo), { at: now, data } satisfies Cache)
      const events = combine([...(await findNew($, repo, bucket(data))), ...(await findActivity($, repo, data))])
      if (events.length > 0) {
        const stored = ((await $.store.get(keyFor(KEYS.fresh, repo))) as PrEvent[] | undefined) ?? []
        await $.store.set(keyFor(KEYS.fresh, repo), [
          ...events,
          ...stored.filter(old => !events.some(e => e.pr.url === old.pr.url && (e.kind === old.kind || e.kind === 'merged'))),
        ])
        const [first] = events
        $.ui.toast(
          events.length === 1 && first
            ? `PR ${first.verb ?? LABELS[first.kind]}${first.by ? ` by ${first.by}` : ''}: #${first.pr.number} ${first.pr.title}`
            : `${events.length} PR updates`,
        )
      }
    }
    if (data === undefined) return

    const buckets = bucket(data)
    const counts: Counts = {
      reviews: data.reviews.length,
      assigned: data.assigned.length,
      mine: data.mine.length,
      failing: buckets.failing,
      approved: buckets.approved.length,
      changes: buckets['changes-requested'].length,
    }
    // News about a PR that has since merged is stale, whether or not its merge was itself news.
    const merged = new Set(data.merged.map(pr => pr.url))
    const stored = ((await $.store.get(keyFor(KEYS.fresh, repo))) as PrEvent[] | undefined) ?? []
    const current = stored.filter(e => e.kind === 'merged' || !merged.has(e.pr.url))
    if (current.length !== stored.length) await $.store.set(keyFor(KEYS.fresh, repo), current)
    await update($, fresh, () => current)
    await update($, snapshot, () => ({ repo, counts, checkedAt }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isRateLimited = /rate limit/i.test(message)
    if (isRateLimited) await $.store.set(BACKOFF_KEY, now + RATE_LIMIT_BACKOFF_MS)
    const retryAt = isRateLimited ? now + REFRESH_MS : null
    await update($, snapshot, prev => ({
      repo: prev?.repo ?? null,
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
  `${event.verb ?? LABELS[event.kind]}${event.by ? ` by ${event.by}` : ''} #${event.pr.number} ${event.pr.title}`
// Keeps a path's end (the file name), cutting from the front.
const cutStart = (text: string, width: number) => (text.length > width ? `…${text.slice(text.length - width + 1)}` : text)
const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]()<>#|~]/g, ch => `\\${ch}`)

const isSame = (a: PrEvent, b: PrEvent) => a.kind === b.kind && a.pr.url === b.pr.url

// The surface opens nothing for a link the plugin answers, so this opens it and clears the item.
const removeEvent = async ($: EngineInterface, event: PrEvent) => {
  const snap = await read($, snapshot)
  const key = keyFor(KEYS.fresh, snap?.repo ?? null)
  const stored = ((await $.store.get(key)) as PrEvent[] | undefined) ?? []
  await $.store.set(key, stored.filter(e => !isSame(e, event)))
  await update($, fresh, list => list.filter(e => !isSame(e, event)))
}

const openEvent = async ($: EngineInterface, event: PrEvent) => {
  await removeEvent($, event)
  const url = event.href ?? event.pr.url
  const opened = await $.process.run(['open', url]).catch(() => null)
  if (opened?.exitCode !== 0) await $.process.run(['xdg-open', url]).catch(() => null)
}

// Uncommitted work against HEAD (staged and unstaged) plus untracked files; local git only.
const readChanges = async ($: EngineInterface): Promise<Change[] | null> => {
  const diff = await $.process.run(['git', 'diff', 'HEAD', '--numstat']).catch(() => null)
  if (diff === null || diff.exitCode !== 0) return null
  const untracked = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard']).catch(() => null)
  const tracked = diff.stdout.split('\n').filter(Boolean).map(line => {
    const [added = '-', deleted = '-', ...path] = line.split('\t')
    return {
      path: path.join('\t'),
      added: added === '-' ? null : Number(added),
      deleted: deleted === '-' ? null : Number(deleted),
      isNew: false,
    }
  })
  const fresh = (untracked?.exitCode === 0 ? untracked.stdout.split('\n').filter(Boolean) : []).map(path => ({
    path,
    added: null,
    deleted: null,
    isNew: true,
  }))

  return [...tracked, ...fresh]
}

const refreshChanges = async ($: EngineInterface) => {
  const list = await readChanges($)
  await update($, changes, () => list)
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refresh($)
    void refreshChanges($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    // A refused registration must not cost the session its pane and polling.
    await $.command.register({ name: CHANGES_COMMAND, description: 'Show uncommitted changes in a side pane' }).catch(() => undefined)
    // Unasked, the surface places it only when there is room for a sidebar; /changes or ⧉ always does.
    void $.ui.open({ id: CHANGES_PANE, title: 'Uncommitted' }).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: CHANGES_COMMAND }, async $ => {
    await refreshChanges($)
    await $.ui.open({ id: CHANGES_PANE, title: 'Uncommitted' })

    return { text: 'Opened the Uncommitted pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const changed = await read($, changes)
    const width = Math.max(20, Math.floor(e.props.bodyColumns * (e.surface === 'terminal' ? 1 : 1.3)) - 10)
    const added = (changed ?? []).reduce((sum, c) => sum + (c.added ?? 0), 0)
    const deleted = (changed ?? []).reduce((sum, c) => sum + (c.deleted ?? 0), 0)

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
        {(changed ?? []).map(change => (
          <Box key={`pane:${change.path}`} flexDirection="row" columnGap={1}>
            <ChangeStat change={change} Box={Box} Text={Text} />
            <Text dimColor size="caption">{cutStart(change.path, width)}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITING_TOOLS.has(String(e.tool))) void refreshChanges($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refreshChanges($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null || (await read($, isHidden))) {
      return next(e)
    }

    const events = await read($, fresh)
    const newReviews = events.filter(event => event.kind === 'review-requested').length
    const commentEvents = events.filter(isComment)
    const [firstComment] = commentEvents
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    // One line per item, cut to the band's width. bodyColumns counts terminal cells; other surfaces
    // draw a proportional font that fits about 1.3 characters per cell (measured on the desktop app).
    const charsPerCell = e.surface === 'terminal' ? 1 : 1.3
    const itemWidth = Math.max(20, Math.floor(e.props.bodyColumns * charsPerCell) - 6)
    const minutes = Math.round(((await $.clock.now()) - snap.checkedAt) / 60000)
    const { counts } = snap
    const LINKS = linksFor(snap.repo)
    const changed = (await read($, changes)) ?? []
    const isOpen = await read($, isChangesOpen)
    const added = changed.reduce((sum, c) => sum + (c.added ?? 0), 0)
    const deleted = changed.reduce((sum, c) => sum + (c.deleted ?? 0), 0)

    return (
      <Box flexDirection="column">
        {/* Items keep their width and wrap as a whole onto the next line rather than breaking. */}
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
            <Text dimColor size="caption">
              {snap.error ?? (minutes < 1 ? 'just now' : `${minutes}m ago`)}
            </Text>
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
        {events.length > 0 && (
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
              <Button key="changes-pane" plain onPress={() => void $.ui.open({ id: CHANGES_PANE, title: 'Uncommitted' }).catch(() => undefined)}>
                <Text dimColor size="caption">⧉</Text>
              </Button>
            </Box>
            {isOpen &&
              changed.slice(0, MAX_CHANGES_SHOWN).map(change => (
                <Box key={`change:${change.path}`} flexDirection="row" columnGap={1}>
                  <ChangeStat change={change} Box={Box} Text={Text} />
                  <Text dimColor size="caption">{cutStart(change.path, itemWidth - 10)}</Text>
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
