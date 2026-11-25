import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { Role } from '@open-usecase/contracts';
import {
  Icon,
  IconButton,
  IdentityBadge,
  Menu,
  MenuItem,
  MenuLabel,
  NavLink as OsNavLink,
  Page,
  PopoverTrigger,
  ShellFooter,
  ShellSwitcher,
  ShellSwitcherButton,
  ShellUser,
  initials,
} from '@openstuff-dev/ui-angular';
import { Session } from './core/session';
import {
  iconCatalogue,
  iconCheck,
  iconInbox,
  iconMenu,
  iconSettings,
  iconSignOut,
} from './shared/icons';

export { initials };

type IconNode = typeof iconInbox;
interface NavItem {
  path: string;
  label: string;
  icon: IconNode;
  roles: readonly Role[];
}

/** The pages in the sidebar, and who sees each. */
const LINKS: NavItem[] = [
  { path: 'inbox', label: 'Inbox', icon: iconInbox, roles: ['admin', 'member'] },
  { path: 'catalogue', label: 'Catalogue', icon: iconCatalogue, roles: ['admin', 'member'] },
];

const ROLE_LABELS: Record<Role, string> = { admin: 'Admin', member: 'Member' };

/**
 * The frame around every signed-in page, laid out like OpenPurpose's: the brand row, the team
 * switch, the pages, and at the bottom who is signed in, with sign-out.
 */
@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    Icon,
    IconButton,
    IdentityBadge,
    Menu,
    MenuItem,
    MenuLabel,
    OsNavLink,
    Page,
    PopoverTrigger,
    ShellFooter,
    ShellSwitcher,
    ShellSwitcherButton,
    ShellUser,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="os-shell" [attr.data-open]="menuOpen() ? '' : null">
      <nav class="os-shell-sidebar" id="sidebar" aria-label="Main">
        <a class="os-shell-brand brand" routerLink="/">
          <!-- The OpenStuff ring with OpenUsecase's check. -->
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <path
              class="ring"
              fill-rule="evenodd"
              d="M16 1.5a14.5 14.5 0 1 0 0 29a14.5 14.5 0 1 0 0-29Zm0 4a10.5 10.5 0 1 1 0 21a10.5 10.5 0 1 1 0-21Z"
            />
            <path class="glyph" d="M9.7 16.3l2-2 3 3 5.6-5.8 2 2-7.6 7.9z" />
          </svg>
          OpenUsecase
        </a>

        @if (me(); as me) {
          @if (me.teams.length || me.isServerAdmin) {
            <div os-shell-switcher>
              <button type="button" os-shell-switcher-button [os-popover-trigger]="wsMenu">
                @if (session.membership(); as current) {
                  <span os-identity-badge aria-hidden="true">{{ initials(current.name) }}</span>
                  <span class="os-shell-switcher-text">
                    <strong>{{ current.name }}</strong>
                    <small>{{ roleLabels[current.role] }}</small>
                  </span>
                } @else {
                  <span os-identity-badge neutral aria-hidden="true">?</span>
                  <span class="os-shell-switcher-text">
                    <strong>Choose a team</strong>
                    <small>{{ me.teams.length }} available</small>
                  </span>
                }
              </button>
              <div
                os-menu
                #wsMenu="osPopover"
                class="os-shell-switcher-menu"
                aria-label="Switch team"
              >
                @if (me.teams.length) {
                  <div os-menu-label>Teams</div>
                  @for (n of me.teams; track n.slug) {
                    <button
                      type="button"
                      os-menu-item
                      role="menuitemradio"
                      [attr.aria-checked]="n.slug === team()"
                      (click)="pick(n.slug)"
                    >
                      <span os-identity-badge size="sm" aria-hidden="true">{{
                        initials(n.name)
                      }}</span>
                      {{ n.name }}
                      @if (n.slug === team()) {
                        <svg os-icon [icon]="icons.check" size="sm"></svg>
                      }
                    </button>
                  }
                }
              </div>
            </div>
          }
        }

        @if (team(); as n) {
          @for (link of links(); track link.path) {
            <a
              os-nav-link
              [routerLink]="['/t', n, link.path]"
              routerLinkActive
              ariaCurrentWhenActive="page"
              [icon]="link.icon"
              >{{ link.label }}</a
            >
          }
        }

        <div os-shell-footer>
          <a
            os-nav-link
            [routerLink]="settingsLink()"
            routerLinkActive
            ariaCurrentWhenActive="page"
            [icon]="icons.settings"
            >Settings</a
          >
          @if (me(); as me) {
            <div os-shell-user [name]="me.name || me.email" [role]="roleLine()">
              <button
                os-icon-button
                variant="ghost"
                type="button"
                label="Sign out"
                title="Sign out"
                (click)="signOut()"
              >
                <svg os-icon [icon]="icons.signOut" size="sm"></svg>
              </button>
            </div>
          }
        </div>
      </nav>

      <div class="os-shell-content">
        <header class="os-shell-topbar">
          <button
            type="button"
            os-icon-button
            class="os-shell-menu"
            variant="ghost"
            label="Menu"
            aria-controls="sidebar"
            [attr.aria-expanded]="menuOpen()"
            (click)="menuOpen.set(!menuOpen())"
          >
            <svg os-icon [icon]="icons.menu"></svg>
          </button>
          @if (session.membership(); as current) {
            <span class="where">{{ current.name }}</span>
          }
        </header>
        <main os-page>
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: `
    .brand .ring {
      fill: var(--os-fg-default);
    }

    .brand .glyph {
      fill: var(--os-brand-default);
    }

    .where {
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }
  `,
})
export class Shell {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly me = this.session.me;
  protected readonly team = this.session.team;
  /** Settings for the team in view, or the account's outside a team. Every member has them. */
  protected readonly settingsLink = computed(() => {
    const team = this.session.team();
    return team ? ['/t', team, 'settings'] : ['/settings'];
  });

  protected readonly menuOpen = signal(false);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly initials = initials;
  protected readonly icons = {
    check: iconCheck,
    menu: iconMenu,
    settings: iconSettings,
    signOut: iconSignOut,
  };

  protected readonly links = computed(() => {
    const role = this.session.role();
    return role ? LINKS.filter((l) => l.roles.includes(role)) : [];
  });

  /** "Server admin", or the role in this team. */
  protected readonly roleLine = computed(() => {
    if (this.me()?.isServerAdmin) return 'Server admin';
    const role = this.session.role();
    return role ? ROLE_LABELS[role] : '';
  });

  constructor() {
    const sync = () => {
      const match = /^\/t\/([^/?#]+)/.exec(this.router.url);
      // Pages outside a team keep the last one in the switch.
      if (match?.[1]) this.session.team.set(decodeURIComponent(match[1]));
      else if (!this.session.team()) {
        this.session.team.set(this.me()?.teams.at(0)?.slug ?? null);
      }
    };
    sync();
    const sub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        sync();
        this.menuOpen.set(false);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
    });
  }

  protected pick(slug: string): void {
    void this.router.navigate(['/t', slug]);
  }

  protected async signOut(): Promise<void> {
    await this.session.signOut();
    await this.router.navigate(['/sign-in']);
  }
}
