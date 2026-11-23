import { Link } from 'react-router-dom';
import { useUnreadCount } from './useNotifications.ts';

const bellIcon = (
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
    <path
      d="M8 1.75a4 4 0 0 0-4 4v2.5L2.5 11v.75h11V11L12 8.25v-2.5a4 4 0 0 0-4-4Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M6.25 13.5a1.75 1.75 0 0 0 3.5 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * The header link to the notifications list. Its name holds the count exactly as the badge shows it ("99+" above 99),
 * so the visible text stays part of the name for people who speak it to a voice control tool. Below 600 px only the
 * icon and badge show.
 */
export function NotificationBell() {
  const unread = useUnreadCount().data?.unread ?? 0;
  const shown = unread > 99 ? '99+' : String(unread);
  return (
    <Link to="/notifications" className="text-link bell" aria-label={unread > 0 ? `Notifications, ${shown} unread` : 'Notifications'}>
      {bellIcon}
      <span className="bell-label">Notifications</span>
      {unread > 0 && (
        <>
          {' '}
          <span className="bell-badge">{shown}</span>
        </>
      )}
    </Link>
  );
}
