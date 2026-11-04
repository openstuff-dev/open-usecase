import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { EmptyState } from '@openstuff-dev/ui-angular';
import { Session } from '../core/session';
import { NewTeam } from './new-team';

/** `/`: straight to the first team's inbox, or what to do when there's none. */
@Component({
  selector: 'app-start',
  imports: [EmptyState, NewTeam],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!session.me()?.teams?.length) {
      @if (session.me()?.isServerAdmin) {
        <os-empty-state title="Add your first team" [level]="1">
          A team holds its own projects, members and agents.
        </os-empty-state>
        <app-new-team />
      } @else {
        <os-empty-state title="You’re not in a team yet" [level]="1">
          Ask an admin to add you, then sign in again.
        </os-empty-state>
      }
    }
  `,
})
export class Start {
  protected readonly session = inject(Session);

  constructor() {
    const first = this.session.me()?.teams[0];
    if (first) void inject(Router).navigate(['/t', first.slug, 'inbox'], { replaceUrl: true });
  }
}
