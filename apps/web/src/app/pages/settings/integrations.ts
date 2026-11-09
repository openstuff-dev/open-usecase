import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { OpenPurposeLink, Role } from '@open-usecase/contracts';
import { allAnnounceGroups } from '@openstuff-dev/ui';
import {
  Button,
  Callout,
  ConfirmDialog,
  Control,
  Field,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { onReturn } from '../../core/loading';
import { Session } from '../../core/session';
import { ServerConnections } from './server-connections';

/** Other OpenStuff apps this team connects to. Today: the OpenPurpose glossary. */
@Component({
  selector: 'app-integrations',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    Field,
    SectionHeader,
    ServerConnections,
    SettingCard,
    SettingCardFooter,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Integrations"
      description="Connect this app to the rest of OpenStuff. Each one is optional, and nothing changes until you connect it."
    ></header>

    @if (serverAdmin()) {
      <app-server-connections tenant="team" [announceGroups]="groups()" />
    }

    @if (team() && admin()) {
      @if (error(); as error) {
        <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
      }

      <section
        os-setting-card
        title="OpenPurpose"
        description="OpenPurpose holds your glossary. With this link, agents are told to keep to its terms, and the inbox marks them. Without it, everything else works the same."
      >
        @if (link(); as link) {
          <p class="connected">
            Connected to {{ link }}
            <button
              os-button
              size="sm"
              variant="ghost"
              tone="danger"
              type="button"
              (click)="removeLink()"
            >
              Remove link
            </button>
          </p>
        }
        <form class="fields" (ngSubmit)="saveLink()">
          <os-field label="OpenPurpose URL" hint="Such as https://purpose.example.com">
            <input os-input type="url" name="openpurposeUrl" required [(ngModel)]="linkUrl" />
          </os-field>
          <os-field
            label="Token"
            hint="An OpenPurpose token that can read this team’s projects. It’s stored encrypted."
          >
            <input
              os-input
              type="password"
              name="openpurposeToken"
              autocomplete="off"
              required
              [(ngModel)]="linkToken"
            />
          </os-field>
          <div>
            <button
              os-button
              variant="primary"
              type="submit"
              [disabled]="!linkUrl.trim() || !linkToken.trim()"
            >
              {{ link() ? 'Update link' : 'Add link' }}
            </button>
          </div>
        </form>
      </section>
    }
  `,
  styles: `
    .connected {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      margin: 0;
    }

    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }
  `,
})
export class Integrations {
  /** The team in the address. Empty outside one, where only server connections show. */
  readonly team = input('');
  readonly admin = input(false);
  readonly serverAdmin = input(false);
  private readonly api = inject(Api);
  private readonly session = inject(Session);

  /** Every team a server admin can see, with every role: the OpenAnnounce groups to create. */
  protected readonly groups = computed(() =>
    allAnnounceGroups(this.session.me()?.teams.map((team) => team.slug) ?? [], ROLES),
  );

  private readonly confirm = inject(ConfirmDialog);
  private readonly toaster = inject(Toaster);
  protected readonly link = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected linkUrl = '';
  protected linkToken = '';

  constructor() {
    effect(() => {
      if (this.team() && this.admin()) void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(
      onReturn(() => {
        if (this.team() && this.admin()) void this.load(this.team());
      }),
    );
  }

  private get base(): string {
    return `/api/t/${this.team()}`;
  }

  protected async saveLink(): Promise<void> {
    this.error.set(null);
    try {
      await this.api.put(`${this.base}/openpurpose`, { url: this.linkUrl, token: this.linkToken });
      this.linkToken = '';
      this.toaster.show('Connected to OpenPurpose.', { tone: 'success' });
      void this.load(this.team());
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  protected async removeLink(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Remove the link to OpenPurpose?',
      message: 'Terms stop being marked, and agents stop being told to keep to them. Nothing else changes.',
      confirmLabel: 'Remove link',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.delete(`${this.base}/openpurpose`);
      this.linkUrl = '';
      void this.load(this.team());
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  private async load(team: string): Promise<void> {
    try {
      const { url } = await this.api.get<OpenPurposeLink>(`/api/t/${team}/openpurpose`);
      if (team !== this.team()) return;
      this.link.set(url);
      this.linkUrl ||= url ?? '';
    } catch (error) {
      if (team === this.team()) this.error.set(errorText(error));
    }
  }
}

const ROLES: readonly Role[] = ['admin', 'member'];
