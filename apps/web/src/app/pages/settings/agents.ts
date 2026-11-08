import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ActorSettings, NewToken, ReviewMode, TeamSettings } from '@open-usecase/contracts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Control,
  EmptyState,
  Field,
  SecretDialog,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Skeleton,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { onReturn, slowLoading } from '../../core/loading';

const MODES: { value: ReviewMode; label: string; hint: string }[] = [
  { value: 'human_approval', label: 'A person approves', hint: 'The default.' },
  {
    value: 'agent_review',
    label: 'A reviewer agent approves',
    hint: 'A different agent with reviewer rights. Needs the user’s request word for word.',
  },
  { value: 'auto_approve', label: 'Approved on arrival', hint: 'No review. The record says so.' },
];

/** Agents and CI jobs: how their proposals are approved, and their tokens. */
@Component({
  selector: 'app-agents',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    EmptyState,
    Field,
    SectionHeader,
    SettingCard,
    SettingCardFooter,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Agents and CI"
      description="Agents connect to /mcp with a token. A CI token can only upload test reports and run the PR check. Neither can ever change what it may do."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
    }

    @if (settings(); as settings) {
      @for (actor of settings.actors; track actor.id) {
        <section
          os-setting-card
          [title]="actor.name"
          [description]="actor.kind === 'ci' ? 'CI job' : 'Agent'"
        >
          @if (actor.kind === 'agent') {
            <div class="fields">
              <os-field label="How its proposals get approved" [hint]="modeHint(actor.review)">
                <select
                  os-select
                  [ngModel]="actor.review"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="setMode(actor, $event)"
                >
                  @for (mode of modes; track mode.value) {
                    <option [value]="mode.value">{{ mode.label }}</option>
                  }
                </select>
              </os-field>
              <label class="check">
                <input
                  type="checkbox"
                  [ngModel]="actor.canReview"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="setCanReview(actor, $event)"
                />
                Can review other agents’ proposals
              </label>
            </div>
          }
          <ul class="tokens">
            @for (token of actor.tokens; track token.id) {
              <li>
                <code>{{ token.prefix }}…</code>
                <button
                  os-button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  type="button"
                  (click)="revoke(token.id, actor.name)"
                >
                  Revoke<span class="os-visually-hidden"> {{ token.prefix }}</span>
                </button>
              </li>
            } @empty {
              <li><small>No working tokens. Make one to connect this agent.</small></li>
            }
          </ul>
          <div os-setting-card-footer>
            <button os-button size="sm" type="button" (click)="addToken(actor)">New token</button>
          </div>
        </section>
      } @empty {
        <os-empty-state title="No agents yet">
          <p>Add one agent per developer and tool, so the history shows who proposed what.</p>
        </os-empty-state>
      }

      <form os-setting-card title="New agent or CI job" (ngSubmit)="addActor()">
        <div class="fields">
          <os-field label="Name">
            <input os-input name="actorName" required [(ngModel)]="actorName" />
          </os-field>
          <os-field label="Kind">
            <select os-select name="actorKind" [(ngModel)]="actorKind">
              <option value="agent">Agent</option>
              <option value="ci">CI</option>
            </select>
          </os-field>
        </div>
        <div os-setting-card-footer>
          <button os-button variant="primary" type="submit" [disabled]="!actorName.trim()">
            Add
          </button>
        </div>
      </form>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="6" />
    }
  `,
  styles: `
    .tokens {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tokens li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      justify-content: space-between;
    }

    small {
      color: var(--os-fg-muted);
    }

    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }

    .check {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      min-block-size: 2.25rem;
      font-size: var(--os-text-sm);
    }
  `,
})
export class Agents {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly confirm = inject(ConfirmDialog);
  private readonly secret = inject(SecretDialog);
  protected readonly settings = signal<TeamSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly modes = MODES;
  protected actorName = '';
  protected actorKind: 'agent' | 'ci' = 'agent';
  private readonly key = new IdempotencyKey();

  constructor() {
    effect(() => {
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private get base(): string {
    return `/api/t/${this.team()}`;
  }

  protected modeHint(mode: ReviewMode): string {
    return MODES.find((m) => m.value === mode)?.hint ?? '';
  }

  protected async addActor(): Promise<void> {
    const name = this.actorName;
    const added = await this.change(() =>
      this.api.post<NewToken>(`${this.base}/actors`, { name, kind: this.actorKind }, this.key.value),
    );
    if (!added) return;
    this.actorName = '';
    await this.secret.show({
      title: `The token for ${name}`,
      secret: added.token,
      what: 'token',
      instructions: 'Give it to the agent or CI job. This is the only time it’s shown.',
    });
  }

  protected async addToken(actor: ActorSettings): Promise<void> {
    const added = await this.change(() =>
      this.api.post<NewToken>(`${this.base}/actors/${actor.id}/tokens`, undefined, this.key.value),
    );
    if (added) {
      await this.secret.show({
        title: `The token for ${actor.name}`,
        secret: added.token,
        what: 'token',
        instructions: 'Give it to the agent or CI job. This is the only time it’s shown.',
      });
    }
  }

  protected async revoke(id: string, name: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Revoke this token of ${name}?`,
      message: 'Anything using it stops working straight away.',
      confirmLabel: 'Revoke token',
      danger: true,
    });
    if (ok) await this.change(() => this.api.delete(`${this.base}/tokens/${id}`));
  }

  protected async setMode(actor: ActorSettings, review: ReviewMode): Promise<void> {
    await this.change(() => this.api.patch(`${this.base}/actors/${actor.id}`, { review }));
  }

  protected async setCanReview(actor: ActorSettings, canReview: boolean): Promise<void> {
    await this.change(() => this.api.patch(`${this.base}/actors/${actor.id}`, { canReview }));
  }

  private async load(team: string): Promise<void> {
    this.error.set(null);
    try {
      const settings = await this.loading.track(
        this.api.get<TeamSettings>(`/api/t/${team}/settings`, {
          onFresh: (fresh) => {
            if (team === this.team()) this.settings.set(fresh);
          },
        }),
      );
      if (team === this.team()) this.settings.set(settings);
    } catch (error) {
      if (team === this.team()) this.error.set(errorText(error));
    }
  }

  private async change<T>(run: () => Promise<T>): Promise<T | null> {
    this.error.set(null);
    try {
      const result = await run();
      this.key.renew();
      void this.load(this.team());
      return result;
    } catch (error) {
      this.error.set(errorText(error));
      return null;
    }
  }
}
