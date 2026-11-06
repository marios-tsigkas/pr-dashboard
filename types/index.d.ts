export type Pr = { url: string; title: string; number: number; repo: string }

export type PrEventKind = 'review-requested' | 'assigned' | 'approved' | 'changes-requested' | 'merged' | 'comment' | 'reply'

// `href` and `by` point at the comment or review itself; `state` is a review's (APPROVED, CHANGES_REQUESTED, COMMENTED).
export type PrEvent = { kind: PrEventKind; pr: Pr; href?: string; by?: string; state?: string }

export type Counts = {
  reviews: number
  assigned: number
  mine: number
  failing: Pr[]
  approved: number
  changes: number
}

export type Snapshot = {
  // owner/name of the session's GitHub repo; null when the session has none (every repo shown).
  repo: string | null
  counts: Counts | null
  checkedAt: number
  error?: string
}

// One uncommitted file against HEAD: lines added / deleted (null for a binary), or untracked.
export type Change = { path: string; added: number | null; deleted: number | null; isNew: boolean }

// A file's diff as unified hunks ('' when there is none to show: binary, a new folder), and the
// lines left out past the cap.
export type Diff = { source: string; omittedLines: number }

// One of today's meetings from the Google Calendar connector: start and end in ms, and its video link if it has one.
export type Meeting = { start: number; end: number; title: string; link: string | null }

// A work link this chat mentioned: Asana, Figma, Confluence or a Claude artifact or design, with a short name from its URL.
export type ChatLink = { kind: 'Asana' | 'Figma' | 'Confluence' | 'Claude'; url: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-dashboard': {
      snapshot: Snapshot | null
      fresh: PrEvent[]
      isHidden: boolean
      // These four by session id (state is shared by the app's sessions). null outside a git repo.
      changes: Record<string, Change[] | null>
      isChangesOpen: Record<string, boolean>
      // Paths whose diff is open in the pane, and each one's diff as last read.
      expanded: Record<string, string[]>
      diffs: Record<string, Record<string, Diff>>
      // Today's meetings not yet over, each with its video link when it has one; null without the Google Calendar connector, or when it fails.
      agenda: Meeting[] | null
      // By session id (state is shared by the app's sessions): newest first, one per URL.
      chatLinks: Record<string, ChatLink[]>
    }
  }
}
