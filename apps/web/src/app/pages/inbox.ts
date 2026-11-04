import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Comment, Glossary, GlossaryTerm, Inbox, InboxItem, Scenario } from '@open-usecase/contracts';
import {
  Button,
  Callout,
  Control,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  PageHeader,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { Comments, Gherkin, termsUsed } from '../shared/gherkin';
import { iconInbox } from '../shared/icons';
import {
  canApprove,
  canReach,
  hasNext,
  hasPrevious,
  moveTo,
  type Reading,
  readingKey,
  startReading,
} from './reading';

/** One use case: what it's about, a card per scenario, and the decision. */
@Component({
  selector: 'app-use-case-review',
  imports: [
    FormsModule,
    Button,
    Callout,
    Comments,
    Control,
    Dialog,
    DialogBody,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Gherkin,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article>
      <header>
        <p class="kicker">
          Feature · {{ item().ref }} · {{ item().project.name }} · revision {{ item().revision }} ·
          proposed by {{ item().proposedBy }}
        </p>
        <h2 class="title">{{ item().title }}</h2>
        @if (item().area; as area) {
          <p class="area">
            {{ area }}
            @if (item().newArea) {
              <span class="new">New area: approving adds it</span>
            }
          </p>
        }
        @if (used().length) {
          <div class="terms" aria-label="Terms this use case uses">
            @for (term of used(); track term.term) {
              <button
                type="button"
                class="chip"
                [class.on]="openTerm() === term.term"
                [attr.aria-expanded]="openTerm() === term.term"
                (click)="toggleTerm(term)"
              >
                {{ term.term }}
              </button>
            }
          </div>
          @if (definition(); as definition) {
            <p class="definition">
              <strong>{{ openTerm() }}:</strong> {{ definition }}
            </p>
          }
        }
        @if (glossary().state === 'unreachable') {
          <p class="area">OpenPurpose can’t be reached, so terms aren’t marked right now.</p>
        }
      </header>

      @if (item().whatChanged; as changed) {
        <section class="note">
          <h3>What changed</h3>
          <p>{{ changed }}</p>
        </section>
      }
      @if (item().originalRequest; as request) {
        <section class="note">
          <h3>What the user asked for</h3>
          <blockquote>{{ request }}</blockquote>
        </section>
      }
      @if (introBlocks().length) {
        <app-gherkin [blocks]="introBlocks()" [terms]="glossary().terms" />
      }
      @if (otherComments().length) {
        <section class="note">
          <h3>Comments on the whole use case</h3>
          <app-comments [comments]="otherComments()" />
        </section>
      }

      @if (scenario(); as scenario) {
        <div class="reader">
          <ol class="progress" aria-label="Scenarios">
            @for (entry of item().scenarios; track entry.number; let i = $index) {
              <li>
                <button
                  type="button"
                  [class.on]="i === reading().at"
                  [class.read]="i !== reading().at && i <= reading().furthest"
                  [disabled]="!reachable(i)"
                  [attr.aria-current]="i === reading().at ? 'step' : null"
                  (click)="go(i)"
                >
                  S{{ entry.number }}
                  @if (commentsOn(entry).length; as count) {
                    <span class="count"
                      >{{ count }}<span class="os-visually-hidden"> comments</span></span
                    >
                  }
                </button>
              </li>
            }
          </ol>

          <section class="card">
            <div class="number" aria-hidden="true">{{ reading().at + 1 }}</div>
            <div class="content">
              <div>
                <p class="position">
                  Scenario {{ reading().at + 1 }} of {{ total() }} · {{ item().ref }}/S{{
                    scenario.number
                  }}
                </p>
                <h3 #scenarioName class="name" tabindex="-1">{{ scenario.name }}</h3>
              </div>
              <app-gherkin [blocks]="scenario.blocks" [terms]="glossary().terms" />
              @if (commentsOn(scenario); as comments) {
                @if (comments.length) {
                  <app-comments [comments]="comments" />
                }
              }
              <form class="draft" (ngSubmit)="saveComment(scenario)">
                <os-field [label]="'Comment on S' + scenario.number" [error]="commentError()">
                  <textarea
                    os-textarea
                    name="body"
                    rows="3"
                    placeholder="Anything missing, wrong or unclear in this scenario?"
                    [ngModel]="draftFor(scenario)"
                    (ngModelChange)="setDraft(scenario, $event)"
                  ></textarea>
                </os-field>
                <div>
                  <button
                    os-button
                    size="sm"
                    type="submit"
                    [loading]="saving()"
                    [disabled]="!draftFor(scenario).trim()"
                  >
                    Save comment
                  </button>
                </div>
              </form>
            </div>
          </section>

          <div class="pager">
            <button
              os-button
              type="button"
              variant="ghost"
              [disabled]="!previous()"
              (click)="go(reading().at - 1)"
            >
              Previous
            </button>
            <button os-button type="button" [disabled]="!next()" (click)="go(reading().at + 1)">
              Next
            </button>
          </div>
        </div>
      }

      @if (error(); as error) {
        <os-callout tone="danger">{{ error }}</os-callout>
      }

      @if (item().retirement; as retirement) {
        <os-callout tone="warning" [title]="retirement.requestedBy + ' asks to retire this'">
          {{ retirement.reason }}
        </os-callout>
        <div class="decision">
          <button os-button variant="danger" type="button" (click)="openDecision('retire')">
            Retire {{ item().ref }}
          </button>
          <button os-button type="button" [loading]="keeping()" (click)="keep()">Keep it</button>
        </div>
      }

      @if (item().needsReview) {
        <div class="decision">
          <button
            os-button
            variant="primary"
            type="button"
            [loading]="approving()"
            [disabled]="approving() || !mayApprove()"
            (click)="approve()"
          >
            Approve {{ item().ref }}
          </button>
          <button os-button type="button" (click)="openDecision('request-changes')">
            Ask for changes
          </button>
          <button os-button type="button" variant="ghost" (click)="openDecision('reject')">
            Reject
          </button>
          @if (!mayApprove()) {
            <p>Read every scenario to approve.</p>
          }
          @if (unsaved().length) {
            <p class="unsaved">
              Save or clear your comment on {{ unsaved().join(', ') }}. It isn't sent yet.
            </p>
          }
        </div>
      }
    </article>

    <dialog os-dialog size="sm" [(open)]="asking">
      <header os-dialog-header>
        <h2 os-dialog-title>{{ wording().title }}</h2>
      </header>
      <form id="decide-with-text" os-dialog-body class="stack" (ngSubmit)="sendDecision()">
        @if (askError(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        <os-field [label]="wording().label" [hint]="wording().hint">
          <textarea
            os-textarea
            name="text"
            rows="5"
            required
            maxlength="10000"
            [(ngModel)]="decisionText"
          ></textarea>
        </os-field>
      </form>
      <footer os-dialog-footer>
        <button os-button type="button" variant="ghost" (click)="asking.set(false)">Cancel</button>
        <button
          os-button
          [variant]="decision() === 'request-changes' ? 'primary' : 'danger'"
          type="submit"
          form="decide-with-text"
          [loading]="sending()"
          [disabled]="!decisionText.trim()"
        >
          {{ wording().send }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
      min-inline-size: 0;
    }

    article {
      display: grid;
      gap: var(--os-space-6);
      padding: var(--os-space-4);
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-xl);
      background: var(--os-bg-surface-100);
      box-shadow: var(--os-shadow-xs);
    }

    @container (inline-size > 40rem) {
      article {
        gap: var(--os-space-8);
        padding: var(--os-space-8);
      }
    }

    header {
      display: grid;
      gap: var(--os-space-2);
      padding-block-end: var(--os-space-6);
      border-block-end: 1px var(--os-border-style) var(--os-border-default);
    }

    .kicker {
      margin: 0;
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    .title {
      margin: 0;
      font-size: var(--os-text-2xl);
      font-weight: var(--os-font-weight-semibold);
      line-height: 1.25;
      text-wrap: balance;
    }

    .area {
      margin: 0;
      color: var(--os-fg-light);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-medium);
    }

    .new {
      margin-inline-start: var(--os-space-1);
      color: var(--os-warning-text);
      font-weight: var(--os-font-weight-regular);
    }

    .terms {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-1);
    }

    .chip {
      padding: 0.1rem var(--os-space-2);
      border: 1px var(--os-border-style) var(--os-brand-border);
      border-radius: var(--os-radius-full);
      background: var(--os-brand-soft);
      color: var(--os-brand-text);
      font: inherit;
      font-size: var(--os-text-xs);
      font-weight: var(--os-font-weight-medium);
      cursor: pointer;
    }

    .chip.on {
      background: var(--os-brand-default);
      color: var(--os-brand-ink);
    }

    .definition {
      margin: 0;
      max-inline-size: 44rem;
      font-size: var(--os-text-sm);
      text-wrap: pretty;
    }

    .definition strong {
      font-weight: var(--os-font-weight-semibold);
    }

    .note h3 {
      margin: 0 0 var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
    }

    .note p,
    blockquote {
      margin: 0;
      max-inline-size: 44rem;
      font-size: var(--os-text-base);
      line-height: 1.6;
      white-space: pre-wrap;
      text-wrap: pretty;
    }

    blockquote {
      padding-inline-start: var(--os-space-3);
      border-inline-start: 2px var(--os-border-style) var(--os-border-strong);
    }

    .reader {
      display: grid;
      gap: var(--os-space-4);
    }

    .progress {
      display: flex;
      gap: var(--os-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .progress li {
      flex: 1;
      min-inline-size: 0;
    }

    .progress button {
      display: flex;
      gap: var(--os-space-1);
      align-items: center;
      inline-size: 100%;
      padding: var(--os-space-2) 0 0;
      border: 0;
      border-block-start: 3px var(--os-border-style) var(--os-border-default);
      background: transparent;
      color: var(--os-fg-muted);
      font: inherit;
      font-size: var(--os-text-xs);
      cursor: pointer;
    }

    .progress button:disabled {
      cursor: default;
    }

    .progress button.read {
      border-color: var(--os-brand-border);
    }

    .progress button.on {
      border-color: var(--os-brand-default);
      color: var(--os-fg-default);
      font-weight: var(--os-font-weight-semibold);
    }

    .count {
      padding-inline: 0.35em;
      border-radius: var(--os-radius-full);
      background: var(--os-brand-soft);
      color: var(--os-brand-text);
      font-variant-numeric: tabular-nums;
    }

    .card {
      display: grid;
      grid-template-columns: 2rem minmax(0, 1fr);
      gap: var(--os-space-4);
      padding: var(--os-space-6);
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-lg);
      background: var(--os-bg-default);
    }

    .number {
      display: grid;
      place-items: center;
      inline-size: 2rem;
      block-size: 2rem;
      border-radius: var(--os-radius-full);
      background: var(--os-brand-soft);
      color: var(--os-brand-text);
      font-weight: var(--os-font-weight-semibold);
      font-variant-numeric: tabular-nums;
    }

    .content {
      display: grid;
      gap: var(--os-space-5);
      min-inline-size: 0;
    }

    .position {
      margin: 0 0 var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      font-variant-numeric: tabular-nums;
    }

    .name:focus {
      outline: none;
    }

    .name {
      margin: 0;
      font-size: var(--os-text-lg);
      font-weight: var(--os-font-weight-semibold);
      line-height: 1.4;
      text-wrap: balance;
    }

    .draft {
      display: grid;
      gap: var(--os-space-2);
      max-inline-size: 44rem;
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
    }

    .pager {
      display: flex;
      justify-content: space-between;
    }

    .decision {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: center;
      padding-block-start: var(--os-space-6);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .decision p {
      margin: 0;
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    .decision .unsaved {
      color: var(--os-warning-text);
    }
  `,
})
export class UseCaseReview {
  private readonly api = inject(Api);
  readonly team = input.required<string>();
  readonly item = input.required<InboxItem>();
  readonly reading = input.required<Reading>();
  readonly glossary = input<Glossary>({ state: 'off', terms: [] });
  /** The person moved to another scenario. */
  readonly moved = output<Reading>();
  /** The use case was decided or commented on, so the list should load again. */
  readonly changed = output<{ decided?: string }>();

  protected readonly openTerm = signal<string | null>(null);

  /** The terms this use case uses, for the row at the top. */
  protected readonly used = computed(() =>
    termsUsed(
      JSON.stringify([this.item().preamble, this.item().scenarios]),
      this.glossary().terms,
    ),
  );

  protected readonly definition = computed(
    () => this.used().find((t) => t.term === this.openTerm())?.definition ?? null,
  );

  protected toggleTerm(term: GlossaryTerm): void {
    this.openTerm.update((open) => (open === term.term ? null : term.term));
  }

  /** Comments still being typed, per scenario, so moving between scenarios keeps them. */
  private readonly drafts = signal(new Map<string, string>());
  protected readonly saving = signal(false);
  protected readonly commentError = signal<string | null>(null);
  protected readonly approving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly asking = signal(false);
  protected readonly decision = signal<'request-changes' | 'reject' | 'retire'>('request-changes');
  protected decisionText = '';
  protected readonly keeping = signal(false);
  protected readonly sending = signal(false);
  protected readonly askError = signal<string | null>(null);
  private readonly commentKey = new IdempotencyKey();
  private readonly scenarioName = viewChild<ElementRef<HTMLElement>>('scenarioName');
  private readonly decisionKey = new IdempotencyKey();

  protected readonly total = computed(() => this.item().scenarios.length);
  protected readonly scenario = computed(() => this.item().scenarios[this.reading().at] ?? null);
  protected readonly previous = computed(() => hasPrevious(this.reading()));
  protected readonly next = computed(() => hasNext(this.reading(), this.total()));
  protected readonly mayApprove = computed(() => canApprove(this.reading(), this.total()));

  /** Scenarios with typed text that isn't saved, so nobody decides thinking it was sent. */
  protected readonly unsaved = computed(() =>
    this.item()
      .scenarios.filter((scenario) => this.draftFor(scenario).trim())
      .map((scenario) => `S${String(scenario.number)}`),
  );

  /** The preamble, without a Feature line that only repeats the title above it. */
  protected readonly introBlocks = computed(() => {
    const { preamble, title } = this.item();
    const first = preamble.at(0);
    const repeats = first?.kind === 'heading' && first.text === title;
    return repeats ? preamble.slice(1) : preamble;
  });

  /** Comments on no scenario on screen: about the whole use case, or a removed scenario. */
  protected readonly otherComments = computed(() => {
    const shown = new Set(this.item().scenarios.map((s) => s.number));
    return this.item().comments.filter((c) => c.scenario === null || !shown.has(c.scenario));
  });

  /** What the dialog says, for the decision it's asking about. */
  protected readonly wording = computed(() => {
    const { comments, revision, ref } = this.item();
    const count = comments.filter((c) => c.revision === revision).length;
    switch (this.decision()) {
      case 'reject':
        return {
          title: `Reject ${ref}?`,
          label: 'Why not',
          hint: 'It stays visible and searchable with this reason, and can’t be revised.',
          send: `Reject ${ref}`,
        };
      case 'retire':
        return {
          title: `Retire ${ref}?`,
          label: 'Why it’s retired',
          hint: 'It stays visible and searchable, and its ID is never used again.',
          send: `Retire ${ref}`,
        };
      default:
        return {
          title: `What should change in ${ref}?`,
          label: 'What should change',
          hint: !count
            ? 'The agent reads this and revises the use case.'
            : count === 1
              ? 'The agent also gets your comment on this revision.'
              : `The agent also gets the ${String(count)} comments on this revision.`,
          send: 'Send to the agent',
        };
    }
  });

  private get base(): string {
    return `/api/t/${this.team()}/usecases/${this.item().id}`;
  }

  protected reachable(index: number): boolean {
    return canReach(this.reading(), index, this.total());
  }

  protected go(index: number): void {
    this.commentError.set(null);
    this.commentKey.renew();
    this.moved.emit(moveTo(this.reading(), index, this.total()));
    // Next turns off on the last scenario, which would drop keyboard focus to the top of the page.
    // The new scenario's name takes it, so a screen reader also says what's on screen now.
    this.scenarioName()?.nativeElement.focus();
  }

  protected commentsOn(scenario: Scenario): Comment[] {
    return this.item().comments.filter((c) => c.scenario === scenario.number);
  }

  private draftKey(scenario: Scenario): string {
    return `${this.item().id}/${String(scenario.number)}`;
  }

  protected draftFor(scenario: Scenario): string {
    return this.drafts().get(this.draftKey(scenario)) ?? '';
  }

  protected setDraft(scenario: Scenario, text: string): void {
    const key = this.draftKey(scenario);
    this.drafts.update((all) => new Map(all).set(key, text));
  }

  protected async saveComment(scenario: Scenario): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.commentError.set(null);
    try {
      await this.api.post(
        `${this.base}/comments`,
        { scenario: scenario.number, body: this.draftFor(scenario) },
        this.commentKey.value,
      );
      this.commentKey.renew();
      this.setDraft(scenario, '');
      this.changed.emit({});
    } catch (error) {
      this.commentError.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async approve(): Promise<void> {
    this.approving.set(true);
    this.error.set(null);
    try {
      await this.api.post(`${this.base}/approve`);
      this.changed.emit({ decided: `${this.item().ref} approved.` });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.approving.set(false);
    }
  }

  protected openDecision(decision: 'request-changes' | 'reject' | 'retire'): void {
    this.decision.set(decision);
    this.decisionText = '';
    this.askError.set(null);
    this.asking.set(true);
  }

  protected async sendDecision(): Promise<void> {
    if (this.sending() || !this.decisionText.trim()) return;
    const decision = this.decision();
    this.sending.set(true);
    this.askError.set(null);
    const { ref } = this.item();
    try {
      await this.api.post(
        `${this.base}/${decision}`,
        decision === 'request-changes'
          ? { changes: this.decisionText }
          : { reason: this.decisionText },
        this.decisionKey.value,
      );
      this.decisionKey.renew();
      this.asking.set(false);
      const done = { 'request-changes': 'sent back for changes', reject: 'rejected', retire: 'retired' };
      this.changed.emit({ decided: `${ref} ${done[decision]}.` });
    } catch (error) {
      this.askError.set(errorText(error));
    } finally {
      this.sending.set(false);
    }
  }

  protected async keep(): Promise<void> {
    this.keeping.set(true);
    this.error.set(null);
    try {
      await this.api.post(`${this.base}/keep`);
      this.changed.emit({ decided: `${this.item().ref} kept.` });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.keeping.set(false);
    }
  }
}

/** What's waiting for a person: a list on one side, one use case to read on the other. */
@Component({
  selector: 'app-inbox',
  imports: [Callout, EmptyState, PageHeader, Skeleton, UseCaseReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Inbox"
      description="Use cases agents want to build. Nothing gets built until a person approves it."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="The inbox didn’t load">{{ error }}</os-callout>
    }

    @if (items(); as items) {
      @if (current(); as item) {
        <div class="split">
          <nav aria-label="Use cases waiting">
            @for (group of groups(); track group.area) {
              @if (group.area) {
                <h2 class="group">{{ group.area }}</h2>
              }
              <ul>
                @for (entry of group.items; track entry.id) {
                  <li>
                    <button
                      type="button"
                      [class.on]="entry.id === item.id"
                      [attr.aria-current]="entry.id === item.id ? 'true' : null"
                      (click)="selected.set(entry.id)"
                    >
                      <span class="ref">{{ entry.ref }}</span>
                      {{ entry.title }}
                      <small>
                        {{ entry.scenarios.length }}
                        {{ entry.scenarios.length === 1 ? 'scenario' : 'scenarios' }}
                      </small>
                    </button>
                  </li>
                }
              </ul>
            }
          </nav>
          <app-use-case-review
            [team]="team()"
            [item]="item"
            [reading]="readingOf(item)"
            [glossary]="glossary()"
            (moved)="setReading(item, $event)"
            (changed)="onChanged($event)"
          />
        </div>
      } @else {
        <os-empty-state title="Nothing is waiting for you" [icon]="iconInbox" [level]="2">
          When an agent proposes a use case, it shows up here.
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <div aria-busy="true"><os-skeleton [lines]="8" /></div>
    }
  `,
  styles: `
    :host {
      container-type: inline-size;
    }

    .split {
      display: grid;
      gap: var(--os-space-6);
    }

    @container (inline-size > 52rem) {
      .split {
        grid-template-columns: 15rem minmax(0, 1fr);
        gap: var(--os-space-8);
        align-items: start;
      }

      nav {
        position: sticky;
        inset-block-start: var(--os-space-4);
      }
    }

    ul {
      display: grid;
      gap: var(--os-space-1);
      margin: 0 0 var(--os-space-4);
      padding: 0;
      list-style: none;
    }

    .group {
      margin: 0 0 var(--os-space-2);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
    }

    nav button {
      display: grid;
      gap: 0.1rem;
      inline-size: 100%;
      padding: var(--os-space-2) var(--os-space-3);
      border: 1px var(--os-border-style) transparent;
      border-radius: var(--os-radius-md);
      background: transparent;
      color: var(--os-fg-default);
      font: inherit;
      font-size: var(--os-text-sm);
      text-align: start;
      cursor: pointer;
    }

    nav button.on {
      border-color: var(--os-border-default);
      background: var(--os-bg-surface-100);
    }

    .ref,
    small {
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
    }
  `,
})
export class InboxPage {
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  readonly team = input.required<string>();
  protected readonly items = signal<InboxItem[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly iconInbox = iconInbox;
  protected readonly selected = signal<string | null>(null);
  private readonly readings = signal(new Map<string, Reading>());
  /** Ignores answers for a load that is no longer on screen. */
  private latest = 0;

  /** The list by area, as the server sorted it. Use cases with no area come last. */
  protected readonly groups = computed(() => {
    const groups: { area: string | null; items: InboxItem[] }[] = [];
    for (const item of this.items() ?? []) {
      const last = groups.at(-1);
      if (last?.area === item.area) last.items.push(item);
      else groups.push({ area: item.area, items: [item] });
    }
    return groups;
  });

  /** Terms for the project on screen, loaded when it's opened. */
  protected readonly glossary = signal<Glossary>({ state: 'off', terms: [] });
  private readonly projectOnScreen = computed(() => this.current()?.project.slug ?? null);

  protected readonly current = computed(() => {
    const items = this.items() ?? [];
    return items.find((item) => item.id === this.selected()) ?? items.at(0) ?? null;
  });

  constructor() {
    effect(() => {
      this.items.set(null);
      void this.load(this.team());
    });
    effect(() => {
      const project = this.projectOnScreen();
      if (project) void this.loadTerms(this.team(), project);
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private async loadTerms(team: string, project: string): Promise<void> {
    try {
      this.glossary.set(await this.api.get<Glossary>(`/api/t/${team}/projects/${project}/terms`));
    } catch {
      // The review works without terms.
      this.glossary.set({ state: 'unreachable', terms: [] });
    }
  }

  protected readingOf(item: InboxItem): Reading {
    return this.readings().get(readingKey(item.id, item.revision)) ?? startReading();
  }

  protected setReading(item: InboxItem, reading: Reading): void {
    const key = readingKey(item.id, item.revision);
    this.readings.update((all) => new Map(all).set(key, reading));
  }

  protected onChanged(event: { decided?: string }): void {
    if (event.decided) this.toaster.show(event.decided);
    void this.load(this.team());
  }

  private async load(team: string): Promise<void> {
    const load = ++this.latest;
    try {
      const inbox = await this.loading.track(
        this.api.get<Inbox>(`/api/t/${team}/inbox`, {
          onFresh: (fresh) => {
            if (load === this.latest) this.items.set(fresh.items);
          },
        }),
      );
      if (load !== this.latest) return;
      this.items.set(inbox.items);
      this.error.set(null);
    } catch (error) {
      if (load === this.latest) this.error.set(errorText(error));
    }
  }
}
