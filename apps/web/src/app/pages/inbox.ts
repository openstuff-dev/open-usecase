import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Comment, Inbox, InboxItem, Scenario } from '@open-usecase/contracts';
import {
  Button,
  Callout,
  Control,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { iconInbox } from '../shared/icons';

/** Comments in the order they were written, as a person reads them. */
@Component({
  selector: 'app-comments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul>
      @for (comment of comments(); track comment.id) {
        <li>
          <strong>{{ comment.author }}</strong>
          <small>on revision {{ comment.revision }}</small>
          <p>{{ comment.body }}</p>
        </li>
      }
    </ul>
  `,
  styles: `
    ul {
      display: grid;
      gap: var(--os-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      padding: var(--os-space-2) var(--os-space-3);
      border-radius: var(--os-radius-sm);
      background: var(--os-bg-surface-100);
      font-size: var(--os-text-sm);
    }

    small {
      margin-inline-start: var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
    }

    p {
      margin: var(--os-space-1) 0 0;
      white-space: pre-wrap;
      text-wrap: pretty;
    }
  `,
})
export class Comments {
  readonly comments = input.required<Comment[]>();
}

/** One use case waiting for a person: its scenarios, comments and the decision. */
@Component({
  selector: 'app-inbox-card',
  imports: [FormsModule, Button, Callout, Comments, Control, Field, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article os-panel [title]="item().ref + ': ' + item().title" [level]="2">
      <p class="meta">
        {{ item().project.name }} · revision {{ item().revision }} · proposed by
        {{ item().proposedBy }}
      </p>

      @if (item().whatChanged; as changed) {
        <div class="note">
          <h3>What changed</h3>
          <p>{{ changed }}</p>
        </div>
      }
      @if (item().originalRequest; as request) {
        <div class="note">
          <h3>What the user asked for</h3>
          <blockquote>{{ request }}</blockquote>
        </div>
      }

      <pre class="gherkin">{{ item().preamble }}</pre>

      @for (scenario of item().scenarios; track scenario.number) {
        <section class="scenario">
          <h3>
            <span class="id">{{ item().ref }}/S{{ scenario.number }}</span>
            {{ scenario.name }}
          </h3>
          <pre class="gherkin">{{ scenario.text }}</pre>
          @if (commentsOn(scenario); as comments) {
            @if (comments.length) {
              <app-comments [comments]="comments" />
            }
          }
          @if (draftFor() === scenario.number) {
            <form class="draft" (ngSubmit)="saveComment(scenario)">
              <os-field [label]="'Comment on S' + scenario.number" [error]="commentError()">
                <textarea os-textarea name="body" rows="3" required [(ngModel)]="draft"></textarea>
              </os-field>
              <div class="row">
                <button os-button size="sm" type="submit" [loading]="saving()">Save comment</button>
                <button os-button size="sm" variant="ghost" type="button" (click)="closeDraft()">
                  Cancel
                </button>
              </div>
            </form>
          } @else {
            <button
              os-button
              size="sm"
              variant="ghost"
              type="button"
              [attr.aria-label]="'Comment on ' + item().ref + '/S' + scenario.number"
              (click)="openDraft(scenario)"
            >
              Comment
            </button>
          }
        </section>
      }

      @if (otherComments().length) {
        <section class="scenario">
          <h3>Other comments</h3>
          <app-comments [comments]="otherComments()" />
        </section>
      }

      @if (error(); as error) {
        <os-callout tone="danger">{{ error }}</os-callout>
      }

      <div class="row">
        <button
          os-button
          variant="primary"
          type="button"
          [loading]="busy() === 'approve'"
          [disabled]="!!busy()"
          (click)="decide('approve')"
        >
          Approve
        </button>
        <button
          os-button
          type="button"
          [loading]="busy() === 'request-changes'"
          [disabled]="!!busy()"
          (click)="decide('request-changes')"
        >
          Ask for changes
        </button>
      </div>
    </article>
  `,
  styles: `
    article {
      container-type: inline-size;
    }

    .meta {
      margin: 0 0 var(--os-space-3);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    .note {
      margin-block-end: var(--os-space-3);
    }

    .note p,
    blockquote {
      margin: 0;
      font-size: var(--os-text-sm);
      white-space: pre-wrap;
      text-wrap: pretty;
    }

    blockquote {
      padding-inline-start: var(--os-space-3);
      border-inline-start: 2px var(--os-border-style) var(--os-border-strong);
      color: var(--os-fg-light);
    }

    h3 {
      margin: 0 0 var(--os-space-1);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
      text-wrap: balance;
    }

    .id {
      margin-inline-end: var(--os-space-1);
      color: var(--os-fg-muted);
      font-variant-numeric: tabular-nums;
      font-weight: var(--os-font-weight-regular);
    }

    .scenario {
      display: grid;
      gap: var(--os-space-2);
      justify-items: start;
      padding-block: var(--os-space-3);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .scenario > * {
      inline-size: 100%;
    }

    .scenario > button {
      inline-size: auto;
    }

    pre.gherkin {
      margin: 0;
      overflow-x: auto;
      font-family: var(--os-font-mono);
      font-size: var(--os-text-sm);
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .draft {
      display: grid;
      gap: var(--os-space-2);
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
    }
  `,
})
export class InboxCard {
  private readonly api = inject(Api);
  readonly team = input.required<string>();
  readonly item = input.required<InboxItem>();
  /** The use case was decided or commented on, so the list should load again. */
  readonly changed = output<{ decided?: string }>();

  protected readonly draftFor = signal<number | null>(null);
  protected draft = '';
  protected readonly saving = signal(false);
  protected readonly commentError = signal<string | null>(null);
  protected readonly busy = signal<'approve' | 'request-changes' | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly commentKey = new IdempotencyKey();

  /** Comments that belong to no scenario on screen: about the whole use case, or a removed one. */
  protected readonly otherComments = computed(() => {
    const shown = new Set(this.item().scenarios.map((s) => s.number));
    return this.item().comments.filter((c) => c.scenario === null || !shown.has(c.scenario));
  });

  private get base(): string {
    return `/api/t/${this.team()}/usecases/${this.item().id}`;
  }

  protected commentsOn(scenario: Scenario): Comment[] {
    return this.item().comments.filter((c) => c.scenario === scenario.number);
  }

  protected openDraft(scenario: Scenario): void {
    this.draft = '';
    this.commentError.set(null);
    this.draftFor.set(scenario.number);
  }

  protected closeDraft(): void {
    this.draftFor.set(null);
  }

  protected async saveComment(scenario: Scenario): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.commentError.set(null);
    try {
      await this.api.post(
        `${this.base}/comments`,
        { scenario: scenario.number, body: this.draft },
        this.commentKey.value,
      );
      this.commentKey.renew();
      this.draftFor.set(null);
      this.changed.emit({});
    } catch (error) {
      this.commentError.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async decide(action: 'approve' | 'request-changes'): Promise<void> {
    this.busy.set(action);
    this.error.set(null);
    try {
      await this.api.post(`${this.base}/${action}`);
      const done = action === 'approve' ? 'approved' : 'sent back for changes';
      this.changed.emit({ decided: `${this.item().ref} ${done}.` });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.busy.set(null);
    }
  }
}

/** What's waiting for a person. Kept small on purpose: approve, ask for changes, comment. */
@Component({
  selector: 'app-inbox',
  imports: [Callout, EmptyState, InboxCard, PageHeader, Skeleton],
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
      @for (item of items; track item.id + '/' + item.revision) {
        <app-inbox-card [team]="team()" [item]="item" (changed)="onChanged($event)" />
      } @empty {
        <os-empty-state title="Nothing is waiting for you" [icon]="iconInbox" [level]="2">
          When an agent proposes a use case, it shows up here.
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <div aria-busy="true"><os-skeleton [lines]="8" /></div>
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
  /** Ignores answers for a load that is no longer on screen. */
  private latest = 0;

  constructor() {
    effect(() => {
      this.items.set(null);
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
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
