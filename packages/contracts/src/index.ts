/** Types shared by the server and the web app. */

export type Role = 'admin' | 'member';

/** How an agent's proposals get approved. An admin sets it, and an agent never can. */
export type ReviewMode = 'human_approval' | 'agent_review' | 'auto_approve';

export interface TeamRef {
  slug: string;
  name: string;
  role: Role;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  teams: TeamRef[];
}

/** A use case's status: retired, else done if a revision is live, else its latest revision's. */
export type UseCaseStatus =
  | 'proposed' |
  'changes_requested' |
  'approved' |
  'rejected' |
  'done' |
  'retired';

/** Which part of a scenario a step belongs to. */
export type StepPhase = 'given' | 'when' | 'then';

/** One piece of Gherkin, read in the project's language. Together they hold every line. */
export type GherkinBlock =
  | { kind: 'heading'; keyword: string; text: string } |
  {
    kind: 'step';
    /** What the keyword means, whatever the language: `and` carries on the part before it. */
    type: StepPhase | 'and' | 'but' | 'star';
    phase: StepPhase | null;
    keyword: string;
    text: string;
  } |
  { kind: 'table'; rows: string[][] } |
  { kind: 'doc'; text: string } |
  { kind: 'tag'; text: string } |
  { kind: 'comment'; text: string } |
  { kind: 'text'; text: string };

/** What the tests say. A regression reads `done · failing` and doesn't change the status. */
export type Health = 'passing' | 'failing' | 'no_evidence';

export interface Scenario {
  /** `2` in `UC-142/S2`. */
  number: number;
  name: string;
  /** Everything that belongs to it except its `Scenario:` line and its `@S2` tag. */
  blocks: GherkinBlock[];
}

export interface Comment {
  id: string;
  /** Which revision it was written on. */
  revision: number;
  /** The scenario it's about, or null when it's about the whole use case. */
  scenario: number | null;
  body: string;
  author: string;
  createdAt: string;
}

/** An agent asks a person to retire a use case. */
export interface RetirementRequest {
  requestedBy: string;
  requestedAt: string;
  reason: string;
}

/** A use case waiting for a person: a revision to review, a retirement to decide, or both. */
export interface InboxItem {
  id: string;
  /** `UC-142`. */
  ref: string;
  title: string;
  project: { slug: string; name: string };
  revision: number;
  proposedBy: string;
  proposedAt: string;
  /** What the user asked for, word for word, when the agent sent it. */
  originalRequest: string | null;
  /** What the agent says changed since the last revision. */
  whatChanged: string | null;
  /** The Gherkin before the first scenario: the Feature line, a description, a Background. */
  preamble: GherkinBlock[];
  scenarios: Scenario[];
  comments: Comment[];
  /** True if this revision waits for review. False if only the retirement is waiting. */
  needsReview: boolean;
  retirement: RetirementRequest | null;
}

export interface Inbox {
  items: InboxItem[];
}

export interface RepositorySettings {
  id: string;
  /** `github.com/acme/shop`. */
  remote: string;
  defaultBranch: string;
}

export interface ProjectSettings {
  id: string;
  slug: string;
  name: string;
  language: string;
  repositories: RepositorySettings[];
}

export interface MemberSettings {
  accountId: string;
  email: string;
  name: string;
  role: Role;
}

export interface TokenSettings {
  id: string;
  /** The start of the token, so people can tell tokens apart. */
  prefix: string;
  createdAt: string;
}

export interface ActorSettings {
  id: string;
  name: string;
  kind: 'agent' | 'ci';
  review: ReviewMode;
  canReview: boolean;
  /** Tokens that still work. */
  tokens: TokenSettings[];
}

export interface TeamSettings {
  projects: ProjectSettings[];
  members: MemberSettings[];
  actors: ActorSettings[];
}

/** A token, shown once and never again. */
export interface NewToken {
  id: string;
  token: string;
  prefix: string;
}

export interface NewMemberResult {
  accountId: string;
  /** Set when a new account was made: shown once, for the admin to pass on. */
  password: string | null;
}

export type ApprovalMethod = 'human' | 'agent_review' | 'auto_approve';

/** One line in the catalogue. */
export interface CatalogueItem {
  id: string;
  ref: string;
  title: string;
  project: { slug: string; name: string };
  status: UseCaseStatus;
  health: Health;
  /** How the revision in force was approved. Null if it hasn't been. */
  approval: ApprovalMethod | null;
  revision: number;
  /** A newer revision waits, or a retirement does. */
  pending: boolean;
}

export interface Catalogue {
  items: CatalogueItem[];
}

export interface ScenarioEvidence {
  number: number;
  name: string;
  blocks: GherkinBlock[];
  health: Health;
  tests: { suite: string; repository: string; result: string; names: string[]; commit: string; at: string }[];
  manual: { by: string; at: string; note: string }[];
}

export interface RevisionSummary {
  number: number;
  state: string;
  proposedBy: string;
  proposedAt: string;
  whatChanged: string | null;
  approval: ApprovalMethod | null;
  decidedBy: string | null;
  decidedAt: string | null;
  prUrl: string | null;
  mergeSha: string | null;
  claimedDoneAt: string | null;
}

/** One use case with everything known about it. */
export interface UseCaseDetail {
  id: string;
  ref: string;
  title: string;
  project: { slug: string; name: string };
  status: UseCaseStatus;
  health: Health;
  originalRequest: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  retireReason: string | null;
  retirement: RetirementRequest | null;
  /** The revision in force: the live one, or else the latest. */
  revision: number;
  preamble: GherkinBlock[];
  scenarios: ScenarioEvidence[];
  /** A newer revision than the one in force, with its text. */
  newer: { revision: number; state: string; preamble: GherkinBlock[]; scenarios: Scenario[] } | null;
  revisions: RevisionSummary[];
  comments: Comment[];
  /** Only when a scenario's health changed. */
  history: { scenario: number; health: Health; commit: string | null; at: string }[];
}

/** What a team takes with it. Never tokens or passwords. */
export interface TeamExport {
  version: 1;
  exportedAt: string;
  team: { slug: string; name: string };
  actors: { id: string; kind: string; name: string; review: ReviewMode; canReview: boolean }[];
  projects: {
    slug: string;
    name: string;
    language: string;
    nextUseCaseNumber: number;
    repositories: { remote: string; defaultBranch: string }[];
    useCases: {
      number: number;
      title: string;
      nextScenarioNumber: number;
      scenarios: number[];
      retiredAt: string | null;
      retiredBy: string | null;
      retireReason: string | null;
      revisions: {
        number: number;
        gherkin: string;
        originalRequest: string | null;
        whatChanged: string | null;
        state: string;
        reviewMode: ReviewMode;
        proposedBy: string;
        decidedBy: string | null;
        decidedAt: string | null;
        approvalMethod: ApprovalMethod | null;
        prUrl: string | null;
        mergeSha: string | null;
        claimedDoneAt: string | null;
        createdAt: string;
      }[];
      comments: {
        revision: number;
        scenario: number | null;
        body: string;
        author: string;
        createdAt: string;
      }[];
      manual: { scenario: number; by: string; at: string; note: string }[];
      history: { scenario: number; health: Health; commit: string | null; at: string }[];
    }[];
  }[];
}
