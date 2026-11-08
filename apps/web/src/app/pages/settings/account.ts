import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Button,
  Callout,
  Control,
  Field,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Toaster,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { Session } from '../../core/session';

/** Your own account: who you are, and your password. */
@Component({
  selector: 'app-account',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
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
      title="Account"
      description="Who you are on this server, and the password you sign in with."
    ></header>

    @if (session.me(); as me) {
      <section
        os-setting-card
        title="Your details"
        description="Your name and email are set by an admin."
      >
        <dl class="facts">
          <dt>Name</dt>
          <dd>{{ me.name || '—' }}</dd>
          <dt>Email</dt>
          <dd>{{ me.email }}</dd>
        </dl>
      </section>
    }

    <form
      os-setting-card
      title="Password"
      description="At least 10 characters. Your other sessions are signed out."
      (ngSubmit)="changePassword()"
    >
      @if (error(); as error) {
        <os-callout tone="danger">{{ error }}</os-callout>
      }
      <div class="fields">
        <os-field label="Current password">
          <input
            os-input
            type="password"
            name="current"
            autocomplete="current-password"
            required
            [(ngModel)]="current"
          />
        </os-field>
        <os-field label="New password">
          <input
            os-input
            type="password"
            name="next"
            autocomplete="new-password"
            required
            minlength="10"
            [(ngModel)]="next"
          />
        </os-field>
      </div>
      <div os-setting-card-footer>
        <button os-button variant="primary" type="submit" [loading]="saving()">
          Change password
        </button>
      </div>
    </form>
  `,
  styles: `
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--os-space-2) var(--os-space-4);
      margin: 0;
    }

    dt {
      color: var(--os-fg-muted);
    }

    dd {
      margin: 0;
    }

    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: end;
    }
  `,
})
export class Account {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected current = '';
  protected next = '';

  protected async changePassword(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.api.put('/api/me/password', { current: this.current, next: this.next });
      this.current = '';
      this.next = '';
      this.toaster.show('Changed your password.', { tone: 'success' });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.saving.set(false);
    }
  }
}
