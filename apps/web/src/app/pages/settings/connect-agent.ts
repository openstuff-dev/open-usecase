import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { TeamSettings } from '@open-usecase/contracts';
import {
  Button,
  Callout,
  Control,
  Field,
  SecretDialog,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { onReturn } from '../../core/loading';
import { Session } from '../../core/session';
import { CopyButton } from '../../shared/copy-button';

/** Connects an agent to this server's MCP address. Admins can make the agent's token here. */
@Component({
  selector: 'app-connect-agent',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    CopyButton,
    Field,
    SectionHeader,
    SettingCard,
    SettingCardFooter,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Connect an agent"
      description="An agent proposes use cases here over MCP. Connect it once, with the address and a token."
    ></header>

    <section
      os-setting-card
      title="MCP address"
      description="The address of this server, for your agent."
    >
      <p class="address">
        <code>{{ mcpUrl }}</code> <app-copy-button [text]="mcpUrl" what="address" />
      </p>
    </section>

    <section
      os-setting-card
      title="Add it to your agent"
      description="Run this where your agent is set up. Replace the placeholder with the agent’s token."
    >
      <p class="address">
        <code class="command">{{ placeholderCommand }}</code>
        <app-copy-button [text]="placeholderCommand" what="command" />
      </p>
    </section>

    @if (isAdmin()) {
      <form
        os-setting-card
        title="Make a token"
        description="The token is shown once. Pass it on with the command."
        (ngSubmit)="makeToken()"
      >
        @if (error(); as error) {
          <os-callout tone="danger">{{ error }}</os-callout>
        }
        @if (agents().length) {
          <os-field label="Agent">
            <select os-select name="agent" required [(ngModel)]="agentId">
              @for (agent of agents(); track agent.id) {
                <option [value]="agent.id">{{ agent.name }}</option>
              }
            </select>
          </os-field>
          <div os-setting-card-footer>
            <button os-button variant="primary" type="submit" [loading]="making()">
              Make a token
            </button>
          </div>
        } @else {
          <p class="hint">Add an agent under Agents and CI first.</p>
        }
      </form>
    } @else {
      <section
        os-setting-card
        title="Token"
        description="An admin makes your agent’s token under Agents and CI."
      >
        <p class="hint">Ask an admin for the token, then use the command above.</p>
      </section>
    }
  `,
  styles: `
    .address {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      margin: 0;
    }

    .command {
      overflow-wrap: anywhere;
    }

    .hint {
      margin: 0;
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }
  `,
})
export class ConnectAgent {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly secret = inject(SecretDialog);
  private readonly session = inject(Session);
  protected readonly isAdmin = computed(() => this.session.me()?.teams.find((t) => t.slug === this.team())?.role === 'admin');
  protected readonly agents = signal<{ id: string; name: string }[]>([]);
  protected readonly making = signal(false);
  protected readonly error = signal<string | null>(null);
  protected agentId = '';
  private readonly key = new IdempotencyKey();

  protected get mcpUrl(): string {
    return `${location.origin}/mcp`;
  }

  constructor() {
    effect(() => {
      if (this.isAdmin()) void this.loadAgents(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.loadAgents(this.team())));
  }

  /** The command with a placeholder, for members who don't have a token. */
  protected get placeholderCommand(): string {
    return this.command('YOUR_TOKEN');
  }

  /** The command an agent runs to connect, with its token. */
  protected command(token: string): string {
    return `claude mcp add --transport http openusecase ${this.mcpUrl} --header "Authorization: Bearer ${token}"`;
  }

  protected async makeToken(): Promise<void> {
    this.making.set(true);
    this.error.set(null);
    try {
      const made = await this.api.post<{ token: string }>(
        `/api/t/${encodeURIComponent(this.team())}/actors/${this.agentId}/tokens`,
        undefined,
        this.key.value,
      );
      this.key.renew();
      await this.secret.show({
        title: 'Command for your agent',
        secret: this.command(made.token),
        what: 'command',
        instructions: 'Run it where the agent is set up. This is the only time the token is shown.',
      });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.making.set(false);
    }
  }

  private async loadAgents(team: string): Promise<void> {
    try {
      const settings = await this.api.get<TeamSettings>(`/api/t/${encodeURIComponent(team)}/settings`);
      const list = settings.actors.filter((a) => a.kind === 'agent').map((a) => ({ id: a.id, name: a.name }));
      this.agents.set(list);
      this.agentId ||= list[0]?.id ?? '';
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
