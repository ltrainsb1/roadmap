import { Link } from 'react-router-dom';

export type SettingsTab = 'security' | 'notifications' | 'calendar';

const TABS: ReadonlyArray<{ tab: SettingsTab; to: string; label: string }> = [
  { tab: 'security', to: '/settings/security', label: 'Security' },
  { tab: 'notifications', to: '/settings/notifications', label: 'Email notifications' },
  { tab: 'calendar', to: '/settings/calendar', label: 'Calendar feed' },
];

/** The row of tabs the settings pages share, the current one marked. */
export function SettingsTabs({ current }: { current: SettingsTab }) {
  return (
    <nav aria-label="Settings" className="tabs">
      {TABS.map((t) => (
        <Link key={t.tab} to={t.to} aria-current={t.tab === current ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
