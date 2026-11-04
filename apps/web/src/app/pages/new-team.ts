import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Button, Control, Field } from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { IdempotencyKey } from '../core/idempotency';
import { Session } from '../core/session';

/** Adds a team and goes to its settings. Only server admins see this. */
@Component({
  selector: 'app-new-team',
  imports: [FormsModule, Button, Control, Field],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (ngSubmit)="add()">
      <os-field label="Team name" [error]="error()">
        <input os-input name="name" required maxlength="120" [(ngModel)]="name" />
      </os-field>
      <button os-button type="submit" [loading]="adding()" [disabled]="!name.trim()">
        Add team
      </button>
    </form>
  `,
  styles: `
    form {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }

    os-field {
      flex: 1 1 16rem;
    }
  `,
})
export class NewTeam {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  protected name = '';
  protected readonly adding = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly key = new IdempotencyKey();

  protected async add(): Promise<void> {
    if (this.adding()) return;
    this.adding.set(true);
    this.error.set(null);
    try {
      const team = await this.api.post<{ slug: string }>(
        '/api/admin/teams',
        { name: this.name },
        this.key.value,
      );
      this.key.renew();
      await this.session.load();
      await this.router.navigate(['/t', team.slug, 'settings']);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.adding.set(false);
    }
  }
}
