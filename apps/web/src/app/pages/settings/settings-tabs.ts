import type { Role } from '@open-usecase/contracts';
import {
  iconAccount,
  iconAgents,
  iconAppearance,
  iconData,
  iconIntegrations,
  iconMembers,
  iconProjects,
  iconTeams,
} from '../../shared/icons';

/** The groups of the Settings menu, in the order they show. */
export type SettingsGroupKey = 'you' | 'team' | 'server';

/** Who is looking: their role in the team in the URL (none outside one), and whether they
 * run the server. */
export interface Who {
  readonly role: Role | null;
  readonly isServerAdmin: boolean;
}

export type SettingsTabId =
  | 'account' |
  'appearance' |
  'connect-agent' |
  'projects' |
  'members' |
  'agents' |
  'integrations' |
  'data' |
  'teams';

export interface SettingsTab {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly icon: typeof iconAccount;
  readonly group: SettingsGroupKey;
  /** Whether this person sees the tab. The server still decides what they may change. */
  readonly visible: (who: Who) => boolean;
}

const everyone = () => true;
const admin = (who: Who) => who.role === 'admin';

/** Every Settings tab. The menu and the redirects both read this list. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'account', label: 'Account', icon: iconAccount, group: 'you', visible: everyone },
  { id: 'appearance', label: 'Appearance', icon: iconAppearance, group: 'you', visible: everyone },
  { id: 'connect-agent', label: 'Connect an agent', icon: iconAgents, group: 'you', visible: everyone },
  { id: 'projects', label: 'Projects', icon: iconProjects, group: 'team', visible: admin },
  { id: 'members', label: 'Members', icon: iconMembers, group: 'team', visible: admin },
  { id: 'agents', label: 'Agents and CI', icon: iconAgents, group: 'team', visible: admin },
  { id: 'integrations', label: 'Integrations', icon: iconIntegrations, group: 'team', visible: admin },
  { id: 'data', label: 'Export and import', icon: iconData, group: 'team', visible: admin },
  { id: 'teams', label: 'Teams', icon: iconTeams, group: 'server', visible: (who) => who.isServerAdmin },
];

/** The tabs this person may open, in menu order. */
export function tabsFor(who: Who): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => tab.visible(who));
}

export function isTabId(id: string): id is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === id);
}
