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
import type { MemberSettings, NewMemberResult, Role, TeamSettings } from '@open-usecase/contracts';
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
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { onReturn, slowLoading } from '../../core/loading';

/** Who reviews in this team, and who manages this page. */
@Component({
  selector: 'app-members',
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
      title="Members"
      description="Any member can review. Admins also manage this page."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
    }

    @if (settings(); as settings) {
      <section
        os-setting-card
        title="People in this team"
        description="Change a role or remove someone at once."
      >
        <ul class="people">
          @for (member of settings.members; track member.accountId) {
            <li>
              <span>
                {{ member.name || member.email }}
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
                  tone="danger"
                  type="button"
                  (click)="removeMember(member)"
                >
                  Remove<span class="os-visually-hidden"> {{ member.name || member.email }}</span>
                </button>
              </span>
            </li>
          }
        </ul>
      </section>

      <form
        os-setting-card
        title="Add a member"
        description="They get a password, shown once, for you to pass on."
        (ngSubmit)="addMember()"
      >
        <div class="fields">
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
        </div>
        <div os-setting-card-footer>
          <button os-button variant="primary" type="submit" [disabled]="!memberEmail.trim()">
            Add member
          </button>
        </div>
      </form>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="5" />
    }
  `,
  styles: `
    .people {
      display: grid;
      gap: var(--os-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .people li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      justify-content: space-between;
      font-size: var(--os-text-sm);
    }

    small {
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
    }

    .actions,
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: flex-end;
    }
  `,
})
export class Members {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  private readonly confirm = inject(ConfirmDialog);
  private readonly secret = inject(SecretDialog);
  protected readonly settings = signal<TeamSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected memberEmail = '';
  protected memberName = '';
  protected memberRole: Role = 'member';
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
      await this.secret.show({
        title: `Password for ${email}`,
        secret: added.password,
        what: 'password',
        instructions: 'Give it to them. They can change it under Settings › Account.',
      });
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
