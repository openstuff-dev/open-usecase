import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Comment, ScenarioEvidence, UseCaseDetail } from '@open-usecase/contracts';
import {
  Badge,
  Button,
  Callout,
  Control,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { Comments, Gherkin } from '../shared/gherkin';
import {
  APPROVAL_LABELS,
  HEALTH_LABELS,
  HEALTH_TONES,
  STATUS_LABELS,
  STATUS_TONES,
} from '../shared/labels';

/** One use case: scenarios with evidence, revisions, comments, the approval and the history. */
@Component({
  selector: 'app-use-case',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    Badge,
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
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    @if (error(); as error) {
      <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
    }

    @if (useCase(); as useCase) {
      <header class="top">
        <a class="back" [routerLink]="['/t', team(), 'catalogue']">Catalogue</a>
        <p class="kicker">
          Feature · {{ useCase.ref }} · {{ useCase.project.name }} · revision {{ useCase.revision }}
        </p>
        <h1>{{ useCase.title }}</h1>
        <form class="area" (ngSubmit)="move()">
          <label for="area-name">Area</label>
          <input
            os-input
            id="area-name"
            name="area"
            list="area-names"
            maxlength="100"
            placeholder="None yet"
            [(ngModel)]="areaName"
          />
          <datalist id="area-names">
            @for (name of useCase.areas; track name) {
              <option [value]="name"></option>
            }
          </datalist>
          @if (areaName.trim() && areaName.trim() !== useCase.area) {
            <button os-button size="sm" type="submit">Move here</button>
          }
        </form>
        <div class="badges">
          <span os-badge [tone]="statusTones[useCase.status]">{{
            statusLabels[useCase.status]
          }}</span>
          <span os-badge [tone]="healthTones[useCase.health]">{{
            healthLabels[useCase.health]
          }}</span>
        </div>
      </header>

      @if (useCase.retiredAt) {
        <os-callout tone="neutral" title="This was retired">
          {{ useCase.retireReason }} {{ useCase.retiredBy }},
          {{ useCase.retiredAt | date: 'mediumDate' }}.
        </os-callout>
      }
      @if (useCase.retirement; as retirement) {
        <os-callout tone="warning" [title]="retirement.requestedBy + ' asks to retire this'">
          {{ retirement.reason }} It’s waiting in the
          <a [routerLink]="['/t', team(), 'inbox']">inbox</a>.
        </os-callout>
      }
      @if (useCase.newer; as newer) {
        <os-callout
          tone="info"
          [title]="'Revision ' + newer.revision + ' is ' + stateLabel(newer.state)"
        >
          The text below stays in force until the new revision goes live.
          @if (newer.state === 'proposed') {
            It’s waiting in the <a [routerLink]="['/t', team(), 'inbox']">inbox</a>.
          }
        </os-callout>
      }

      @if (useCase.originalRequest; as request) {
        <section class="note">
          <h2>What the user asked for</h2>
          <blockquote>{{ request }}</blockquote>
        </section>
      }

      @if (intro().length) {
        <app-gherkin [blocks]="intro()" />
      }

      <section class="group">
        <h2>Scenarios</h2>
        @for (scenario of useCase.scenarios; track scenario.number) {
          <article class="card">
            <header>
              <div>
                <p class="position">{{ useCase.ref }}/S{{ scenario.number }}</p>
                <h3>{{ scenario.name }}</h3>
              </div>
              <span os-badge [tone]="healthTones[scenario.health]">{{
                healthLabels[scenario.health]
              }}</span>
            </header>
            <app-gherkin [blocks]="scenario.blocks" />

            @if (scenario.tests.length || scenario.manual.length) {
              <ul class="evidence">
                @for (test of scenario.tests; track test.repository + test.suite) {
                  <li>
                    <strong [class.failed]="test.result === 'failed'">{{
                      test.result === 'failed' ? 'Failed' : 'Passed'
                    }}</strong>
                    in {{ test.repository }}, {{ test.suite }}, at
                    <code>{{ test.commit.slice(0, 7) }}</code>
                    <small>{{ test.names.join(', ') }}</small>
                  </li>
                }
                @for (check of scenario.manual; track check.at) {
                  <li>
                    <strong>Checked by hand</strong> by {{ check.by }},
                    {{ check.at | date: 'mediumDate' }}
                    <small>{{ check.note }}</small>
                  </li>
                }
              </ul>
            }

            @if (commentsOn(scenario.number); as comments) {
              @if (comments.length) {
                <app-comments [comments]="comments" />
              }
            }

            @if (!useCase.retiredAt) {
              <div>
                <button
                  os-button
                  size="sm"
                  variant="ghost"
                  type="button"
                  (click)="openCheck(scenario)"
                >
                  I checked this by hand<span class="os-visually-hidden">
                    ({{ useCase.ref }}/S{{ scenario.number }})</span
                  >
                </button>
              </div>
            }
          </article>
        }
      </section>

      @if (otherComments().length) {
        <section class="group">
          <h2>Comments on the whole use case</h2>
          <app-comments [comments]="otherComments()" />
        </section>
      }

      <section class="group">
        <h2>Revisions</h2>
        <ol class="rows">
          @for (revision of useCase.revisions; track revision.number) {
            <li>
              <strong>Revision {{ revision.number }}</strong> · {{ stateLabel(revision.state) }}
              <small>
                Proposed by {{ revision.proposedBy }},
                {{ revision.proposedAt | date: 'mediumDate' }}.
                @if (revision.approval; as approval) {
                  Approved by {{ approvalLabels[approval] }}
                  @if (revision.decidedBy) {
                    ({{ revision.decidedBy }})
                  }
                  .
                }
                @if (revision.claimedDoneAt) {
                  Claimed done
                  @if (revision.prUrl) {
                    in <a [href]="revision.prUrl" rel="noopener">the pull request</a>
                  }
                  .
                }
              </small>
              @if (revision.whatChanged) {
                <p>{{ revision.whatChanged }}</p>
              }
            </li>
          }
        </ol>
      </section>

      @if (useCase.history.length) {
        <section class="group">
          <h2>Test history</h2>
          <ol class="rows">
            @for (event of useCase.history; track event.at + event.scenario) {
              <li>
                {{ useCase.ref }}/S{{ event.scenario }} became
                <strong>{{ healthLabels[event.health] }}</strong>
                <small>
                  {{ event.at | date: 'medium' }}
                  @if (event.commit) {
                    at <code>{{ event.commit.slice(0, 7) }}</code>
                  }
                </small>
              </li>
            }
          </ol>
        </section>
      }

      @if (useCase.status === 'done' && !useCase.retirement) {
        <div>
          <button os-button type="button" variant="ghost" (click)="openRetire()">
            Retire {{ useCase.ref }}
          </button>
        </div>
      }

      <dialog os-dialog size="sm" [(open)]="dialogOpen">
        <header os-dialog-header>
          <h2 os-dialog-title>
            {{ checking() ? 'What did you check?' : 'Retire ' + useCase.ref + '?' }}
          </h2>
        </header>
        <form id="use-case-dialog" os-dialog-body class="stack" (ngSubmit)="sendDialog()">
          @if (dialogError(); as error) {
            <os-callout tone="danger">{{ error }}</os-callout>
          }
          <os-field
            [label]="checking() ? 'What you did and saw' : 'Why it’s retired'"
            [hint]="
              checking()
                ? 'It counts as evidence, and is always labelled as manual.'
                : 'It stays visible and searchable, and its ID is never used again.'
            "
          >
            <textarea
              os-textarea
              name="text"
              rows="4"
              required
              maxlength="5000"
              [(ngModel)]="dialogText"
            ></textarea>
          </os-field>
        </form>
        <footer os-dialog-footer>
          <button os-button type="button" variant="ghost" (click)="dialogOpen.set(false)">
            Cancel
          </button>
          <button
            os-button
            variant="primary"
            type="submit"
            form="use-case-dialog"
            [loading]="sending()"
            [disabled]="!dialogText.trim()"
          >
            {{ checking() ? 'Save the check' : 'Retire it' }}
          </button>
        </footer>
      </dialog>
    } @else if (loading.slow()) {
      <div aria-busy="true"><os-skeleton [lines]="10" /></div>
    }
  `,
  styles: `
    .top {
      display: grid;
      gap: var(--os-space-2);
    }

    .back,
    .kicker {
      margin: 0;
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    h1 {
      margin: 0;
      font-size: var(--os-text-2xl);
      font-weight: var(--os-font-weight-semibold);
      line-height: 1.25;
      text-wrap: balance;
    }

    .area {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      font-size: var(--os-text-sm);
    }

    .area input {
      inline-size: 14rem;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
    }

    .group {
      display: grid;
      gap: var(--os-space-3);
    }

    h2 {
      margin: 0;
      font-size: var(--os-text-lg);
      font-weight: var(--os-font-weight-semibold);
    }

    .note h2 {
      margin-block-end: var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    blockquote {
      margin: 0;
      padding-inline-start: var(--os-space-3);
      border-inline-start: 2px var(--os-border-style) var(--os-border-strong);
      white-space: pre-wrap;
    }

    .card {
      display: grid;
      gap: var(--os-space-4);
      padding: var(--os-space-5);
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-lg);
      background: var(--os-bg-surface-100);
    }

    .card > header {
      display: flex;
      gap: var(--os-space-3);
      align-items: flex-start;
      justify-content: space-between;
    }

    .position {
      margin: 0 0 var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }

    h3 {
      margin: 0;
      font-size: var(--os-text-md);
      font-weight: var(--os-font-weight-semibold);
      text-wrap: balance;
    }

    .evidence,
    .rows {
      display: grid;
      gap: var(--os-space-2);
      margin: 0;
      padding: 0;
      font-size: var(--os-text-sm);
      list-style: none;
    }

    .evidence {
      padding-block-start: var(--os-space-3);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .rows li {
      padding-block: var(--os-space-2);
    }

    .rows li + li {
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .rows p {
      margin: var(--os-space-1) 0 0;
    }

    small {
      display: block;
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
      overflow-wrap: anywhere;
    }

    strong {
      font-weight: var(--os-font-weight-semibold);
    }

    .failed {
      color: var(--os-danger-text);
    }

    code {
      font-family: var(--os-font-mono);
    }
  `,
})
export class UseCasePage {
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  readonly team = input.required<string>();
  readonly id = input.required<string>();
  protected readonly useCase = signal<UseCaseDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly healthLabels = HEALTH_LABELS;
  protected readonly statusTones = STATUS_TONES;
  protected readonly healthTones = HEALTH_TONES;
  protected readonly approvalLabels = APPROVAL_LABELS;
  protected readonly dialogOpen = signal(false);
  protected readonly checking = signal<ScenarioEvidence | null>(null);
  protected dialogText = '';
  protected areaName = '';
  protected readonly sending = signal(false);
  protected readonly dialogError = signal<string | null>(null);
  private readonly key = new IdempotencyKey();
  private latest = 0;

  /** The preamble, without a Feature line that only repeats the title. */
  protected readonly intro = computed(() => {
    const useCase = this.useCase();
    if (!useCase) return [];
    const first = useCase.preamble.at(0);
    const repeats = first?.kind === 'heading' && first.text === useCase.title;
    return repeats ? useCase.preamble.slice(1) : useCase.preamble;
  });

  protected readonly otherComments = computed(() => {
    const useCase = this.useCase();
    if (!useCase) return [];
    const shown = new Set(useCase.scenarios.map((s) => s.number));
    return useCase.comments.filter((c) => c.scenario === null || !shown.has(c.scenario));
  });

  constructor() {
    effect(() => {
      this.useCase.set(null);
      void this.load();
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load()));
  }

  private get base(): string {
    return `/api/t/${this.team()}/usecases/${this.id()}`;
  }

  private async load(): Promise<void> {
    const load = ++this.latest;
    try {
      const useCase = await this.loading.track(
        this.api.get<UseCaseDetail>(this.base, {
          onFresh: (fresh) => {
            if (load === this.latest) this.useCase.set(fresh);
          },
        }),
      );
      if (load !== this.latest) return;
      this.useCase.set(useCase);
      this.areaName = useCase.area ?? '';
      this.error.set(null);
    } catch (error) {
      if (load === this.latest) this.error.set(errorText(error));
    }
  }

  protected async move(): Promise<void> {
    try {
      await this.api.patch(`${this.base}/area`, { area: this.areaName.trim() });
      this.toaster.show(`Moved to ${this.areaName.trim()}.`);
      void this.load();
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  protected stateLabel(state: string): string {
    return state.replace('_', ' ');
  }

  protected commentsOn(scenario: number): Comment[] {
    return this.useCase()?.comments.filter((c) => c.scenario === scenario) ?? [];
  }

  protected openCheck(scenario: ScenarioEvidence): void {
    this.checking.set(scenario);
    this.open();
  }

  protected openRetire(): void {
    this.checking.set(null);
    this.open();
  }

  private open(): void {
    this.dialogText = '';
    this.dialogError.set(null);
    this.dialogOpen.set(true);
  }

  protected async sendDialog(): Promise<void> {
    if (this.sending() || !this.dialogText.trim()) return;
    this.sending.set(true);
    this.dialogError.set(null);
    const scenario = this.checking();
    try {
      await (scenario
        ? this.api.post(
            `${this.base}/scenarios/${String(scenario.number)}/verify`,
            { note: this.dialogText },
            this.key.value,
          )
        : this.api.post(`${this.base}/retire`, { reason: this.dialogText }, this.key.value));
      this.key.renew();
      this.dialogOpen.set(false);
      this.toaster.show(scenario ? 'Your check is on record.' : 'Retired.');
      void this.load();
    } catch (error) {
      this.dialogError.set(errorText(error));
    } finally {
      this.sending.set(false);
    }
  }
}
