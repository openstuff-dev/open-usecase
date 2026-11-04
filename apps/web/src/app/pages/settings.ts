import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type {
  ActorSettings,
  MemberSettings,
  NewMemberResult,
  NewToken,
  ProjectSettings,
  ReviewMode,
  Role,
  TeamSettings,
} from '@open-usecase/contracts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Control,
  Field,
  PageHeader,
  Panel,
  Skeleton,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { onReturn, slowLoading } from '../core/loading';
import { Session } from '../core/session';
import { CopyButton } from '../shared/copy-button';
import { NewTeam } from './new-team';

const MODES: { value: ReviewMode; label: string; hint: string }[] = [
  { value: 'human_approval', label: 'A person approves', hint: 'The default.' },
  {
    value: 'agent_review',
    label: 'A reviewer agent approves',
    hint: 'A different agent with reviewer rights. Needs the user’s request word for word.',
  },
  { value: 'auto_approve', label: 'Approved on arrival', hint: 'No review. The record says so.' },
];

/** Projects and repositories, members, agents and their modes, tokens. For a team's admins. */
@Component({
  selector: 'app-settings',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    CopyButton,
    Field,
    NewTeam,
    PageHeader,
    Panel,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Settings"
      description="Which repositories belong to this team, who can review, and what each agent may do."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
    }

    @if (shown(); as shown) {
      <os-callout tone="info" [title]="shown.title">
        <p class="once">
          This is the only time it’s shown: <code>{{ shown.secret }}</code>
          <app-copy-button [text]="shown.secret" [what]="shown.what" />
        </p>
      </os-callout>
    }

    @if (settings(); as settings) {
      <section os-panel title="Projects" [level]="2">
        <p class="hint">
          Agents propose from a repository, and its git remote says which project it’s for.
        </p>
        @for (project of settings.projects; track project.id) {
          <div class="row-block">
            <h3>
              {{ project.name }} <small>{{ project.language }}</small>
            </h3>
            <ul class="plain">
              @for (repository of project.repositories; track repository.id) {
                <li>
                  <span
                    >{{ repository.remote }} <small>{{ repository.defaultBranch }}</small></span
                  >
                  <button
                    os-button
                    size="sm"
                    variant="ghost"
                    type="button"
                    (click)="removeRepository(repository.id, repository.remote)"
                  >
                    Remove<span class="os-visually-hidden"> {{ repository.remote }}</span>
                  </button>
                </li>
              }
            </ul>
            <form class="inline" (ngSubmit)="addRepository(project)">
              <os-field
                [label]="'Add a repository to ' + project.name"
                hint="Its git remote, such as git@github.com:acme/shop.git"
              >
                <input
                  os-input
                  [name]="'remote-' + project.id"
                  required
                  [ngModel]="repositoryDraft(project)"
                  (ngModelChange)="setRepositoryDraft(project, $event)"
                />
              </os-field>
              <button os-button type="submit" [disabled]="!repositoryDraft(project).trim()">
                Add repository
              </button>
            </form>
          </div>
        } @empty {
          <p class="hint">No projects yet. Add one with the repository agents work in.</p>
        }
        <form class="inline new" (ngSubmit)="addProject()">
          <os-field label="New project">
            <input os-input name="projectName" required [(ngModel)]="projectName" />
          </os-field>
          <os-field label="Git remote">
            <input os-input name="projectRemote" required [(ngModel)]="projectRemote" />
          </os-field>
          <os-field label="Gherkin language" hint="A code such as en or nl">
            <input os-input name="projectLanguage" required [(ngModel)]="projectLanguage" />
          </os-field>
          <button os-button type="submit" [disabled]="!projectName.trim() || !projectRemote.trim()">
            Add project
          </button>
        </form>
      </section>

      <section os-panel title="Members" [level]="2">
        <p class="hint">Any member can review. Admins also manage this page.</p>
        <ul class="plain">
          @for (member of settings.members; track member.accountId) {
            <li>
              <span
                >{{ member.name || member.email }}
                @if (member.name) {
                  <small>{{ member.email }}</small>
                }
              </span>
              <span class="actions">
                <select
                  os-select
                  [attr.aria-label]="'Role of ' + (member.name || member.email)"
                  [ngModel]="member.role"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="changeRole(member, $event)"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  os-button
                  size="sm"
                  variant="ghost"
                  type="button"
                  (click)="removeMember(member)"
                >
                  Remove<span class="os-visually-hidden"> {{ member.name || member.email }}</span>
                </button>
              </span>
            </li>
          }
        </ul>
        <form class="inline new" (ngSubmit)="addMember()">
          <os-field label="Email">
            <input os-input type="email" name="memberEmail" required [(ngModel)]="memberEmail" />
          </os-field>
          <os-field label="Name (optional)">
            <input os-input name="memberName" [(ngModel)]="memberName" />
          </os-field>
          <os-field label="Role">
            <select os-select name="memberRole" [(ngModel)]="memberRole">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </os-field>
          <button os-button type="submit" [disabled]="!memberEmail.trim()">Add member</button>
        </form>
      </section>

      <section os-panel title="Agents and CI" [level]="2">
        <p class="hint">
          Agents connect to <code>/mcp</code> with a token. A CI token can only upload test reports
          and run the PR check. Neither can ever change what it may do.
        </p>
        @for (actor of settings.actors; track actor.id) {
          <div class="row-block">
            <h3>
              {{ actor.name }} <small>{{ actor.kind === 'ci' ? 'CI' : 'Agent' }}</small>
            </h3>
            @if (actor.kind === 'agent') {
              <div class="inline">
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
            <ul class="plain">
              @for (token of actor.tokens; track token.id) {
                <li>
                  <code>{{ token.prefix }}…</code>
                  <button
                    os-button
                    size="sm"
                    variant="ghost"
                    type="button"
                    (click)="revoke(token.id, actor.name)"
                  >
                    Revoke<span class="os-visually-hidden"> {{ token.prefix }}</span>
                  </button>
                </li>
              } @empty {
                <li><small>No working tokens.</small></li>
              }
            </ul>
            <button os-button size="sm" type="button" (click)="addToken(actor)">New token</button>
          </div>
        } @empty {
          <p class="hint">No agents yet.</p>
        }
        <form class="inline new" (ngSubmit)="addActor()">
          <os-field label="New agent or CI job">
            <input os-input name="actorName" required [(ngModel)]="actorName" />
          </os-field>
          <os-field label="Kind">
            <select os-select name="actorKind" [(ngModel)]="actorKind">
              <option value="agent">Agent</option>
              <option value="ci">CI</option>
            </select>
          </os-field>
          <button os-button type="submit" [disabled]="!actorName.trim()">Add</button>
        </form>
      </section>

      @if (session.me()?.isServerAdmin) {
        <section os-panel title="Teams on this server" [level]="2">
          <p class="hint">Only server admins see this.</p>
          <app-new-team />
        </section>
      }
    } @else if (loading.slow()) {
      <div aria-busy="true"><os-skeleton [lines]="10" /></div>
    }
  `,
  styles: `
    .hint {
      margin: 0 0 var(--os-space-4);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      text-wrap: pretty;
    }

    .once {
      margin: 0;
      overflow-wrap: anywhere;
    }

    code {
      font-family: var(--os-font-mono);
      font-size: 0.92em;
    }

    .row-block {
      display: grid;
      gap: var(--os-space-3);
      justify-items: start;
      padding-block: var(--os-space-4);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .row-block > * {
      inline-size: 100%;
    }

    .row-block > button {
      inline-size: auto;
    }

    h3 {
      margin: 0;
      font-size: var(--os-text-base);
      font-weight: var(--os-font-weight-semibold);
    }

    small {
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
      font-weight: var(--os-font-weight-regular);
    }

    .plain {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .plain li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      justify-content: space-between;
      font-size: var(--os-text-sm);
    }

    .actions {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
    }

    .inline {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }

    .inline os-field {
      flex: 1 1 14rem;
    }

    .new {
      padding-block-start: var(--os-space-4);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
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
export class SettingsPage {
  private readonly api = inject(Api);
  private readonly confirm = inject(ConfirmDialog);
  private readonly toaster = inject(Toaster);
  protected readonly session = inject(Session);
  readonly team = input.required<string>();
  protected readonly settings = signal<TeamSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly shown = signal<{ title: string; secret: string; what: string } | null>(null);
  protected readonly loading = slowLoading();
  protected readonly modes = MODES;
  protected projectName = '';
  protected projectRemote = '';
  protected projectLanguage = 'en';
  protected memberEmail = '';
  protected memberName = '';
  protected memberRole: Role = 'member';
  protected actorName = '';
  protected actorKind: 'agent' | 'ci' = 'agent';
  private readonly repositoryDrafts = signal(new Map<string, string>());
  private readonly key = new IdempotencyKey();
  private latest = 0;

  constructor() {
    effect(() => {
      this.settings.set(null);
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private get base(): string {
    return `/api/t/${this.team()}`;
  }

  private async load(team: string): Promise<void> {
    const load = ++this.latest;
    try {
      const settings = await this.loading.track(
        this.api.get<TeamSettings>(`/api/t/${team}/settings`, {
          onFresh: (fresh) => {
            if (load === this.latest) this.settings.set(fresh);
          },
        }),
      );
      if (load === this.latest) this.settings.set(settings);
    } catch (error) {
      if (load === this.latest) this.error.set(errorText(error));
    }
  }

  /** Runs a change, shows what went wrong if it fails, and loads the page again. */
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

  protected modeHint(mode: ReviewMode): string {
    return MODES.find((m) => m.value === mode)?.hint ?? '';
  }

  protected repositoryDraft(project: ProjectSettings): string {
    return this.repositoryDrafts().get(project.id) ?? '';
  }

  protected setRepositoryDraft(project: ProjectSettings, text: string): void {
    this.repositoryDrafts.update((all) => new Map(all).set(project.id, text));
  }

  protected async addProject(): Promise<void> {
    const done = await this.change(() =>
      this.api.post(
        `${this.base}/projects`,
        { name: this.projectName, remote: this.projectRemote, language: this.projectLanguage },
        this.key.value,
      ),
    );
    if (done) {
      this.projectName = '';
      this.projectRemote = '';
    }
  }

  protected async addRepository(project: ProjectSettings): Promise<void> {
    const done = await this.change(() =>
      this.api.post(
        `${this.base}/projects/${project.id}/repositories`,
        { remote: this.repositoryDraft(project) },
        this.key.value,
      ),
    );
    if (done) this.setRepositoryDraft(project, '');
  }

  protected async removeRepository(id: string, remote: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove ${remote}?`,
      message: 'Agents and CI can’t use this repository until it’s added again. Use cases stay.',
      confirmLabel: 'Remove repository',
      danger: true,
    });
    if (ok) await this.change(() => this.api.delete(`${this.base}/repositories/${id}`));
  }

  protected async addMember(): Promise<void> {
    const email = this.memberEmail;
    const added = await this.change(() =>
      this.api.post<NewMemberResult>(
        `${this.base}/members`,
        { email, name: this.memberName, role: this.memberRole },
        this.key.value,
      ),
    );
    if (!added) return;
    this.memberEmail = '';
    this.memberName = '';
    if (added.password) {
      this.shown.set({ title: `Send ${email} their password`, secret: added.password, what: 'password' });
    } else {
      this.toaster.show(`${email} already had an account, and is now in this team.`);
    }
  }

  protected async changeRole(member: MemberSettings, role: Role): Promise<void> {
    await this.change(() => this.api.patch(`${this.base}/members/${member.accountId}`, { role }));
  }

  protected async removeMember(member: MemberSettings): Promise<void> {
    const who = member.name || member.email;
    const ok = await this.confirm.confirm({
      title: `Remove ${who}?`,
      message: 'They can’t see this team any more. What they reviewed stays on record.',
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (ok) await this.change(() => this.api.delete(`${this.base}/members/${member.accountId}`));
  }

  protected async addActor(): Promise<void> {
    const name = this.actorName;
    const added = await this.change(() =>
      this.api.post<NewToken>(`${this.base}/actors`, { name, kind: this.actorKind }, this.key.value),
    );
    if (!added) return;
    this.actorName = '';
    this.shown.set({ title: `The token for ${name}`, secret: added.token, what: 'token' });
  }

  protected async addToken(actor: ActorSettings): Promise<void> {
    const added = await this.change(() =>
      this.api.post<NewToken>(`${this.base}/actors/${actor.id}/tokens`, undefined, this.key.value),
    );
    if (added) {
      this.shown.set({ title: `The token for ${actor.name}`, secret: added.token, what: 'token' });
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
}
