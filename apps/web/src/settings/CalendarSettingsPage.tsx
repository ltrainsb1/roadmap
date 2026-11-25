import { formatDayUtc, type FeedState, type Membership } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CALENDAR_FEED_LOAD_FAILED, CALENDAR_SAVE_FAILED, errorCode, messageFor } from '../api/errors.ts';
import { ME_KEY, useMe } from '../auth/useMe.ts';
import { formatNotificationTime } from '../notifications/when.ts';
import { todayIn } from '../projects/today.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { ErrorIcon, Field } from '../ui/Field.tsx';
import { Layout } from '../ui/Layout.tsx';
import { COPY_FAILED, LINK_COPIED, useCopyLink } from '../ui/useCopyLink.ts';
import { useLeaveGuard } from '../ui/useLeaveGuard.tsx';
import { SettingsTabs } from './SettingsTabs.tsx';
import { useCalendarFeed, useCreateFeed, useNewFeedLink, useSaveFeedChoices, useTurnOffFeed } from './useCalendarFeed.ts';

type Feed = NonNullable<FeedState['feed']>;
/** The choices as kept: a chosen list can be left empty when a roadmap in it is deleted. */
type KeptChoices = Feed['choices'];

const INSTRUCTIONS = [
  'Google Calendar: Other calendars, +, From URL, then paste the link.',
  'Apple Calendar: File, New Calendar Subscription, then paste the link.',
  'Outlook: Add calendar, Subscribe from web, then paste the link.',
];
const DELAY_NOTE =
  "Calendar apps check for changes every few hours, and Google can take longer. To add one item right away, use Add to calendar on the item. It will then show twice, and the added copy won't update when the item changes.";
const NO_ROADMAP = 'Choose at least one roadmap.';
const NOTHING_TO_SHOW = 'Choose item dates, milestones or both.';

/** The form's own values: the chosen list is remembered while "All my roadmaps" is on, so switching back keeps it. */
interface Values {
  mode: 'all' | 'some';
  chosen: readonly string[];
  itemDates: boolean;
  milestones: boolean;
  onlyMine: boolean;
}

const valuesOf = (c: KeptChoices): Values => ({
  mode: c.roadmaps === 'all' ? 'all' : 'some',
  chosen: c.roadmaps === 'all' ? [] : c.roadmaps,
  itemDates: c.itemDates,
  milestones: c.milestones,
  onlyMine: c.onlyMine,
});

/** What a save sends: only roadmaps the person is still a member of, in the order the page lists them. */
const choicesOf = (v: Values, memberships: readonly Membership[]): KeptChoices => ({
  roadmaps: v.mode === 'all' ? 'all' : memberships.filter((m) => v.chosen.includes(m.roadmapId)).map((m) => m.roadmapId),
  itemDates: v.itemDates,
  milestones: v.milestones,
  onlyMine: v.onlyMine,
});

const sameChoices = (a: KeptChoices, b: KeptChoices) => JSON.stringify(a) === JSON.stringify(b);

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="alert" className="field-error">
      <ErrorIcon />
      <span>{children}</span>
    </p>
  );
}

/**
 * The form starts from the saved choices and is not touched by later refetches, so nothing chosen is lost. An empty
 * list and nothing to show are said as soon as they happen, and "Save changes" sends nothing until they are put right.
 */
function ChoicesForm({ saved, memberships }: { saved: KeptChoices; memberships: readonly Membership[] }) {
  const save = useSaveFeedChoices();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => valuesOf(saved));
  // What the form was last started or saved from, to tell whether anything is unsaved.
  const [base, setBase] = useState(() => valuesOf(saved));
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  const sending = useRef(false);
  const roadmapList = useRef<HTMLDivElement>(null);
  const onlyThese = useRef<HTMLInputElement>(null);
  const itemDates = useRef<HTMLInputElement>(null);

  const choices = choicesOf(values, memberships);
  const dirty = !sameChoices(choices, choicesOf(base, memberships));
  const leaveDialog = useLeaveGuard(dirty);
  const noRoadmap = choices.roadmaps !== 'all' && choices.roadmaps.length === 0;
  const nothingToShow = !values.itemDates && !values.milestones;

  const change = (next: Partial<Values>) => {
    setValues((v) => ({ ...v, ...next }));
    setStatus((s) => (s === 'saved' ? 'idle' : s));
  };
  const toggle = (roadmapId: string, on: boolean) =>
    change({ chosen: on ? [...values.chosen, roadmapId] : values.chosen.filter((id) => id !== roadmapId) });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (noRoadmap) return (roadmapList.current?.querySelector('input') ?? onlyThese.current)?.focus();
    if (nothingToShow) return itemDates.current?.focus();
    if (sending.current) return;
    sending.current = true;
    setStatus('idle');
    save.mutate(choices, {
      onSuccess: (data) => {
        if (data.feed) setBase(valuesOf(data.feed.choices));
        setStatus('saved');
      },
      onError: (err) => {
        // A roadmap the person has just left: the list is refreshed so it can be chosen again.
        if (errorCode(err) === 'unknown_roadmap') void queryClient.invalidateQueries({ queryKey: ME_KEY });
        setStatus('failed');
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  };

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="feed-form">
        <fieldset className="panel-group">
          <legend>Roadmaps</legend>
          <div className="check">
            <input
              id="feed-roadmaps-all"
              type="radio"
              name="feed-roadmaps"
              checked={values.mode === 'all'}
              onChange={() => change({ mode: 'all' })}
            />
            <label htmlFor="feed-roadmaps-all">All my roadmaps</label>
          </div>
          <div className="check">
            <input
              id="feed-roadmaps-some"
              ref={onlyThese}
              type="radio"
              name="feed-roadmaps"
              checked={values.mode === 'some'}
              onChange={() => change({ mode: 'some' })}
            />
            <label id="feed-roadmaps-some-label" htmlFor="feed-roadmaps-some">
              Only these
            </label>
          </div>
          {/* Disabled rather than hidden while "All my roadmaps" is on, so the page doesn't jump. */}
          <div ref={roadmapList} role="group" aria-labelledby="feed-roadmaps-some-label" className="feed-roadmaps">
            {memberships.map((m) => (
              <div className="check" key={m.roadmapId}>
                <input
                  id={`feed-roadmap-${m.roadmapId}`}
                  type="checkbox"
                  checked={values.chosen.includes(m.roadmapId)}
                  disabled={values.mode === 'all'}
                  onChange={(e) => toggle(m.roadmapId, e.target.checked)}
                />
                <label htmlFor={`feed-roadmap-${m.roadmapId}`}>{m.roadmapName}</label>
              </div>
            ))}
          </div>
          {noRoadmap && <FieldError id="feed-roadmaps-error">{NO_ROADMAP}</FieldError>}
        </fieldset>

        <fieldset className="panel-group" aria-describedby="feed-show-hint">
          <legend>Show</legend>
          <p id="feed-show-hint" className="hint">
            Item dates show as one entry from the start date to the end date.
          </p>
          <div className="check">
            <input
              id="feed-item-dates"
              ref={itemDates}
              type="checkbox"
              checked={values.itemDates}
              onChange={(e) => change({ itemDates: e.target.checked })}
            />
            <label htmlFor="feed-item-dates">Item dates</label>
          </div>
          <div className="check">
            <input
              id="feed-milestones"
              type="checkbox"
              checked={values.milestones}
              onChange={(e) => change({ milestones: e.target.checked })}
            />
            <label htmlFor="feed-milestones">Milestones</label>
          </div>
          {nothingToShow && <FieldError id="feed-show-error">{NOTHING_TO_SHOW}</FieldError>}
        </fieldset>

        <div className="check">
          <input id="feed-only-mine" type="checkbox" checked={values.onlyMine} onChange={(e) => change({ onlyMine: e.target.checked })} />
          <label htmlFor="feed-only-mine">Only items assigned to me</label>
        </div>

        {status === 'failed' && <Alert>{CALENDAR_SAVE_FAILED}</Alert>}
        <Button type="submit" variant="primary">
          Save changes
        </Button>
        <div role="status" className="saved">
          {/* A change made while the save was on its way is not in it, so the screen is not what was saved. */}
          {status === 'saved' && !dirty ? 'Saved.' : ''}
        </div>
      </form>
      {/* Outside the form: the dialog has a form of its own. */}
      {leaveDialog}
    </>
  );
}

/** The link just made: the one time it is ever shown. */
function JustMade({ url }: { url: string }) {
  const copyLink = useCopyLink();
  return (
    <>
      <p className="feed-warning">Anyone with this link can see the dates it shows. Copy it now: for your safety it can't be shown again.</p>
      <Field id="calendar-link" label="Calendar link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
      {copyLink.result === 'failed' && <Alert>{COPY_FAILED}</Alert>}
      <p role="status" className="notice">
        {copyLink.result === 'copied' ? LINK_COPIED : ''}
      </p>
      <Button onClick={() => void copyLink.copy(url)}>Copy link</Button>
      <h3 id="feed-instructions">Add it to your calendar</h3>
      <ul aria-labelledby="feed-instructions" className="feed-instructions">
        {INSTRUCTIONS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/** A later visit: the link can't be shown, so the page says what it knows about it. */
function Active({ feed, timeZone }: { feed: Feed; timeZone: string }) {
  // The current link's date: a new link has its own, while the feed's createdAt stays (it keys the choices form).
  const made = formatDayUtc(todayIn(timeZone, new Date(feed.linkCreatedAt)));
  return (
    <>
      <p>{`Your calendar link is active. It was made on ${made}.`}</p>
      <p>
        {feed.lastFetchedAt
          ? `A calendar app last checked it on ${formatNotificationTime(feed.lastFetchedAt, timeZone)}.`
          : 'No calendar app has checked it yet.'}
      </p>
      <p>For your safety the link can't be shown again. If you've lost it, get a new link.</p>
    </>
  );
}

function FeedSettings({ state }: { state: FeedState }) {
  const me = useMe();
  const create = useCreateFeed();
  const newLink = useNewFeedLink();
  const turnOff = useTurnOffFeed();
  // The link from the last create or new link, kept only on this screen and never in the query cache.
  const [url, setUrl] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | undefined>();
  const [asking, setAsking] = useState<'new_link' | 'turn_off' | null>(null);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const busy = useRef(false);
  // Where focus goes once the screen shows the result of an action; a ref, so the effect runs after that render.
  const focusNext = useRef<'link' | 'create' | null>(null);
  const linkHeading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const timeZone = me.data?.user.timezone ?? 'UTC';
  const memberships = me.data?.memberships ?? [];

  useEffect(() => {
    const target = focusNext.current === 'link' ? linkHeading.current : focusNext.current === 'create' ? createButton.current : null;
    if (!target) return;
    target.focus();
    focusNext.current = null;
  });

  /** One action at a time; a second press while one is on its way does nothing. */
  const once = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await action();
    } finally {
      busy.current = false;
    }
  };

  const onCreate = () =>
    once(async () => {
      setCreateError(undefined);
      try {
        const link = await create.mutateAsync();
        focusNext.current = 'link';
        setUrl(link.url);
      } catch (err) {
        setCreateError(messageFor(err));
      } finally {
        // The mutation keeps what it got back, link included; the screen's own state is all it needs.
        create.reset();
      }
    });

  const closeDialog = () => {
    setAsking(null);
    setDialogError(undefined);
  };

  const onNewLink = () =>
    once(async () => {
      try {
        const link = await newLink.mutateAsync();
        focusNext.current = 'link';
        setUrl(link.url);
        closeDialog();
      } catch (err) {
        setDialogError(messageFor(err));
      } finally {
        newLink.reset();
      }
    });

  const onTurnOff = () =>
    once(async () => {
      try {
        await turnOff.mutateAsync();
        focusNext.current = 'create';
        setUrl(null);
        closeDialog();
      } catch (err) {
        setDialogError(messageFor(err));
      }
    });

  if (!state.feed) {
    return (
      <>
        {createError && <Alert>{createError}</Alert>}
        <Button ref={createButton} variant="primary" onClick={() => void onCreate()}>
          Create calendar link
        </Button>
      </>
    );
  }

  return (
    <>
      <section aria-labelledby="feed-link-heading" className="feed-link">
        <h2 id="feed-link-heading" ref={linkHeading} tabIndex={-1}>
          Your calendar link
        </h2>
        {/* Keyed by the link, so a new link starts without the last one's "Link copied.". */}
        {url ? <JustMade key={url} url={url} /> : <Active feed={state.feed} timeZone={timeZone} />}
        <p className="hint">{DELAY_NOTE}</p>
      </section>

      {/* Keyed by the feed, so a feed turned off and made again starts from its own choices. */}
      <ChoicesForm key={state.feed.createdAt} saved={state.feed.choices} memberships={memberships} />

      <div className="feed-actions">
        <Button onClick={() => setAsking('new_link')}>Get a new link</Button>
        <Button variant="danger" onClick={() => setAsking('turn_off')}>
          Turn off the feed
        </Button>
      </div>

      <ConfirmDialog
        open={asking === 'new_link'}
        title="Get a new calendar link?"
        confirmLabel="Get new link"
        error={asking === 'new_link' ? dialogError : undefined}
        onConfirm={() => void onNewLink()}
        onClose={closeDialog}
      >
        <p>The current link stops working, and calendars that use it stop updating. You'll need to add the new link to them.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'turn_off'}
        title="Turn off your calendar feed?"
        confirmLabel="Turn off"
        error={asking === 'turn_off' ? dialogError : undefined}
        onConfirm={() => void onTurnOff()}
        onClose={closeDialog}
      >
        <p>The link stops working and calendars that use it stop updating. Your roadmap dates stay in the app.</p>
      </ConfirmDialog>
    </>
  );
}

export function CalendarSettingsPage() {
  const feed = useCalendarFeed();
  return (
    <Layout width="wide" signedIn>
      <SettingsTabs current="calendar" />
      <h1>Calendar feed</h1>
      <p>See your roadmap dates in Google Calendar, Apple Calendar or Outlook. The calendar updates on its own when dates change.</p>
      {feed.isPending && <p role="status">Loading</p>}
      {feed.data ? (
        <FeedSettings state={feed.data} />
      ) : (
        feed.isError && (
          <>
            <Alert>{CALENDAR_FEED_LOAD_FAILED}</Alert>
            <Button onClick={() => void feed.refetch()}>Try again</Button>
          </>
        )
      )}
    </Layout>
  );
}
