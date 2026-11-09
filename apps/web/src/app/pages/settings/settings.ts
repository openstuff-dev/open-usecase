import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { NavLink, PageHeader, Settings, SettingsGroup, SettingsNav } from '@openstuff-dev/ui-angular';
import { Session } from '../../core/session';
import { Account } from './account';
import { Agents } from './agents';
import { Appearance } from './appearance';
import { ConnectAgent } from './connect-agent';
import { Data } from './data';
import { Integrations } from './integrations';
import { Members } from './members';
import { Projects } from './projects';
import { Teams } from './teams';
import {
  SETTINGS_TABS,
  type SettingsGroupKey,
  type SettingsTabId,
  type Who,
  isTabId,
  tabsFor,
} from './settings-tabs';

const GROUP_ORDER: readonly SettingsGroupKey[] = ['you', 'team', 'server'];

/**
 * Settings: one menu, one tab per page. Inside a team the address names it
 * (`/t/:team/settings/:tab`), so a shared link opens the right one. Outside a team it's
 * `/settings/:tab`.
 */
@Component({
  selector: 'app-settings',
  imports: [
    Account,
    Agents,
    Appearance,
    ConnectAgent,
    Data,
    Integrations,
    Members,
    Projects,
    Teams,
    NavLink,
    PageHeader,
    RouterLink,
    RouterLinkActive,
    Settings,
    SettingsGroup,
    SettingsNav,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Settings"
      description="Your account and your agents, and for admins, the team and its data."
    ></header>

    <os-settings>
      <nav os-settings-nav label="Settings">
        @for (group of groups(); track group.key) {
          <os-settings-group [label]="group.label">
            @for (tab of group.tabs; track tab.id) {
              <a
                os-settings-link
                [icon]="tab.icon"
                [routerLink]="linkTo(tab.id)"
                routerLinkActive
                ariaCurrentWhenActive="page"
              >
                {{ tab.label }}
              </a>
            }
          </os-settings-group>
        }
      </nav>

      @if (allowed()) {
        @switch (tab()) {
          @case ('account') {
            <app-account />
          }
          @case ('appearance') {
            <app-appearance />
          }
          @case ('connect-agent') {
            <app-connect-agent [team]="team()" />
          }
          @case ('projects') {
            <app-projects [team]="team()" />
          }
          @case ('members') {
            <app-members [team]="team()" />
          }
          @case ('agents') {
            <app-agents [team]="team()" />
          }
          @case ('integrations') {
            <app-integrations
              [team]="team()"
              [admin]="who().role === 'admin'"
              [serverAdmin]="who().isServerAdmin"
            />
          }
          @case ('data') {
            <app-data [team]="team()" />
          }
          @case ('teams') {
            <app-teams />
          }
        }
      }
    </os-settings>
  `,
})
export class SettingsPage {
  /** From `settings/:tab` or `t/:team/settings/:tab`. */
  readonly tab = input<string>('account');
  /** From `t/:team/settings/:tab`. Empty outside a team. */
  readonly team = input<string>('');
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  private readonly membership = computed(() => {
    const slug = this.team();
    return this.session.me()?.teams.find((t) => t.slug === slug) ?? null;
  });

  protected readonly who = computed<Who>(() => ({
    role: this.membership()?.role ?? null,
    isServerAdmin: this.session.me()?.isServerAdmin ?? false,
  }));

  protected readonly groups = computed(() => {
    const visible = tabsFor(this.who());
    const names: Record<SettingsGroupKey, string> = {
      you: 'You',
      team: this.membership()?.name ?? 'Team',
      server: 'Server',
    };
    return GROUP_ORDER.map((key) => ({
      key,
      label: names[key],
      tabs: visible.filter((tab) => tab.group === key),
    })).filter((group) => group.tabs.length > 0);
  });

  /** A tab this person can't use redirects to Account, and a tab that doesn't exist does too. */
  protected readonly allowed = computed(() => {
    const id = this.tab();
    return isTabId(id) && tabsFor(this.who()).some((tab) => tab.id === id);
  });

  constructor() {
    effect(() => {
      if (!this.allowed()) void this.router.navigate(this.linkTo('account'), { replaceUrl: true });
    });
  }

  /** Server tabs always live at `/settings/…`. The others sit in the team named in the URL. */
  protected linkTo(id: SettingsTabId): string[] {
    const team = this.team();
    const server = SETTINGS_TABS.find((tab) => tab.id === id)?.group === 'server';
    if (server || !team) return ['/settings', id];
    return ['/t', team, 'settings', id];
  }
}
