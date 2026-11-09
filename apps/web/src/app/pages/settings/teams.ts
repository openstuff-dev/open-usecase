import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SectionHeader, SettingCard, SettingCardBody } from '@openstuff-dev/ui-angular';
import { NewTeam } from '../new-team';

/** For server admins: add a team on this server. */
@Component({
  selector: 'app-teams',
  imports: [NewTeam, SectionHeader, SettingCard, SettingCardBody],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Teams"
      description="Each team has its own projects, agents and members. Only server admins see this tab."
    ></header>

    <section
      os-setting-card
      title="Add a team"
      description="Then you can add people and projects to it."
    >
      <div os-setting-card-body><app-new-team /></div>
    </section>
  `,
})
export class Teams {}
