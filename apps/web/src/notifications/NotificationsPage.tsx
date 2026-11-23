import { formatDates, notificationSentence, type Notification } from '@roadmap/shared';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { NOTIFICATIONS_LOAD_FAILED, NOTIFICATIONS_MARK_FAILED } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Layout } from '../ui/Layout.tsx';
import { useMarkAllRead, useMarkRead, useNotifications } from './useNotifications.ts';
import { formatNotificationTime } from './when.ts';

/** "{old dates} → {new dates}" for a dates row, then the roadmap (left out if it is gone), then the time. */
function metaParts(n: Notification, timeZone: string) {
  const parts: string[] = [];
  if (n.detail.kind === 'dates') {
    const { before, after } = n.detail;
    parts.push(`${formatDates(before.startDate, before.endDate)} → ${formatDates(after.startDate, after.endDate)}`);
  }
  if (n.roadmapName) parts.push(n.roadmapName);
  return (
    <>
      {parts.map((p) => `${p} · `).join('')}
      <time dateTime={n.createdAt}>{formatNotificationTime(n.createdAt, timeZone)}</time>
    </>
  );
}

function Row({ n, timeZone, onOpen }: { n: Notification; timeZone: string; onOpen: (n: Notification) => void }) {
  return (
    <li className={n.read ? 'notification' : 'notification unread'}>
      <Link to={`/r/${encodeURIComponent(n.roadmapId)}/projects/${encodeURIComponent(n.projectId)}`} onClick={() => onOpen(n)}>
        <span className="notification-text">
          <span className="notification-sentence">{notificationSentence(n)}</span>
          {n.detail.kind === 'mentioned' && <span className="notification-excerpt">{`“${n.detail.excerpt}”`}</span>}
          <span className="notification-meta">{metaParts(n, timeZone)}</span>
        </span>
        {!n.read && (
          <>
            <span className="unread-dot" aria-hidden="true" />
            <span className="sr-only">Unread</span>
          </>
        )}
      </Link>
    </li>
  );
}

export function NotificationsPage() {
  const timeZone = useMe().data?.user.timezone ?? 'UTC';
  const list = useNotifications();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // The index of the first row a "Show more" asked for, until focus has moved there.
  const firstNew = useRef<number | null>(null);

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = list.data?.pages[0]?.unread ?? 0;

  useEffect(() => {
    const at = firstNew.current;
    if (at === null || items.length <= at) return;
    firstNew.current = null;
    listRef.current?.querySelectorAll('a')[at]?.focus();
  }, [items.length]);

  // Fire and forget: the link goes to the item whether or not the mark lands.
  const onOpen = (n: Notification) => {
    if (!n.read) markRead.mutate(n.id);
  };

  const onMarkAll = () =>
    markAll.mutate(undefined, {
      onSuccess: () => heading.current?.focus(),
    });

  const onShowMore = () => {
    firstNew.current = items.length;
    void list.fetchNextPage();
  };

  return (
    <Layout width="wide" signedIn>
      <h1 ref={heading} tabIndex={-1}>
        Notifications
      </h1>
      {markAll.isError && <Alert>{NOTIFICATIONS_MARK_FAILED}</Alert>}
      {unread > 0 && (
        <Button variant="primary" className="mark-all" onClick={onMarkAll}>
          Mark all as read
        </Button>
      )}

      {list.isPending && <p role="status">Loading</p>}
      {list.isError && (
        <>
          <Alert>{NOTIFICATIONS_LOAD_FAILED}</Alert>
          <Button onClick={() => void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch())}>Try again</Button>
        </>
      )}
      {list.isSuccess && items.length === 0 && <p>No notifications yet.</p>}
      {items.length > 0 && (
        <ol ref={listRef} className="notification-list" aria-label="Notifications">
          {items.map((n) => (
            <Row key={n.id} n={n} timeZone={timeZone} onOpen={onOpen} />
          ))}
        </ol>
      )}
      {list.hasNextPage && !list.isError && (
        <Button onClick={onShowMore} className="show-more">
          Show more
        </Button>
      )}
      <p>
        <Link to="/settings/notifications" className="text-link">
          Change which emails you get
        </Link>
      </p>
    </Layout>
  );
}
