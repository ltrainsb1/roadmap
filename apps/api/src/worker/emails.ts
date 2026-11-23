import { formatDates, formatDayUtc, noteExcerpt, notificationSentence, type Notification } from '@roadmap/shared';
import { escapeHtml, htmlPage, oneLine, type EmailContent } from '../mail/templates.ts';
import { localDate } from './local-time.ts';

// Every value from a row (titles, names, excerpts, roadmap names) is untrusted: the HTML escapes it, the subject is
// one line, and the text body puts each value on one line.

export const itemUrl = (appOrigin: string, n: Pick<Notification, 'roadmapId' | 'projectId'>): string =>
  `${appOrigin}/r/${encodeURIComponent(n.roadmapId)}/projects/${encodeURIComponent(n.projectId)}`;

const FOOTER_TEXT = 'You get this email because of your notification settings. Change them:';

function footer(appOrigin: string): { text: string; html: string } {
  const url = `${appOrigin}/settings/notifications`;
  const u = escapeHtml(url);
  return { text: `${FOOTER_TEXT} ${url}`, html: `<p>${escapeHtml(FOOTER_TEXT)} <a href="${u}">${u}</a></p>` };
}

const sentence = (n: Notification): string => oneLine(notificationSentence(n));

/** The excerpt in quotes, for a mention; cut again in case a row holds more than an excerpt should. */
function quote(n: Notification): string | null {
  return n.detail.kind === 'mentioned' ? `“${oneLine(noteExcerpt(n.detail.excerpt))}”` : null;
}

/** "{old dates} → {new dates} · {roadmap} · {day}", the day in the recipient's zone; parts that are empty drop out. */
function facts(n: Notification, timeZone: string): string {
  const d = n.detail;
  const change = d.kind === 'dates' ? `${formatDates(d.before.startDate, d.before.endDate)} → ${formatDates(d.after.startDate, d.after.endDate)}` : '';
  const day = formatDayUtc(localDate(new Date(n.createdAt), timeZone));
  return [change, oneLine(n.roadmapName), day].filter((p) => p !== '').join(' · ');
}

/** One notification, sent as it happens. */
export function instantEmail(n: Notification, o: { appOrigin: string; timeZone: string }): EmailContent {
  const url = itemUrl(o.appOrigin, n);
  const u = escapeHtml(url);
  const lines = [sentence(n), quote(n), facts(n, o.timeZone)].filter((l): l is string => l !== null);
  const foot = footer(o.appOrigin);
  return {
    subject: oneLine(notificationSentence(n, { forSubject: true })),
    text: [...lines, '', `Open the item: ${url}`, '', foot.text].join('\n'),
    html: htmlPage([...lines.map((l) => `<p>${escapeHtml(l)}</p>`), `<p>Open the item: <a href="${u}">${u}</a></p>`, foot.html]),
  };
}

/** The day's waiting notifications in one email, a section per roadmap in the order each first appears. */
export function digestEmail(rows: Notification[], o: { appOrigin: string; date: string }): EmailContent {
  const groups = new Map<string, Notification[]>();
  for (const n of rows) groups.set(n.roadmapId, [...(groups.get(n.roadmapId) ?? []), n]);
  const intro = "Here's what happened since your last digest.";
  const foot = footer(o.appOrigin);
  const text = [intro, ''];
  const html = [`<p>${escapeHtml(intro)}</p>`];
  for (const group of groups.values()) {
    const name = oneLine(group[0]!.roadmapName);
    text.push(name, ...group.map((n) => `${sentence(n)} ${itemUrl(o.appOrigin, n)}`), '');
    const items = group.map((n) => `<li><a href="${escapeHtml(itemUrl(o.appOrigin, n))}">${escapeHtml(sentence(n))}</a></li>`);
    html.push(`<h2>${escapeHtml(name)}</h2>`, `<ul>${items.join('')}</ul>`);
  }
  text.push(foot.text);
  html.push(foot.html);
  return { subject: `Your roadmap updates for ${formatDayUtc(o.date)}`, text: text.join('\n'), html: htmlPage(html) };
}
