export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/** A header value must stay on one line, whatever a user typed into a roadmap name. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Wraps already-escaped paragraphs and one link in the same plain layout. */
function layout(paragraphs: string[], url: string, linkLabel: string, footer: string): string {
  const u = escapeHtml(url);
  return [
    '<!doctype html><html><body style="font-family:sans-serif;line-height:1.5;color:#111">',
    ...paragraphs.map((p) => `<p>${p}</p>`),
    `<p><a href="${u}">${escapeHtml(linkLabel)}</a></p>`,
    `<p>Or paste this address into your browser:<br>${u}</p>`,
    `<p>${footer}</p>`,
    '</body></html>',
  ].join('\n');
}

export function inviteEmail(p: { roadmapName: string; inviterName: string; url: string }): EmailContent {
  const roadmap = escapeHtml(p.roadmapName);
  const inviter = escapeHtml(p.inviterName);
  return {
    subject: oneLine(`${p.inviterName} invited you to ${p.roadmapName}`),
    text: [
      `${p.inviterName} invited you to the roadmap "${p.roadmapName}".`,
      '',
      `Accept the invite: ${p.url}`,
      '',
      'The link works for 7 days. If you were not expecting this, you can ignore this email.',
    ].join('\n'),
    html: layout(
      [`${inviter} invited you to the roadmap &quot;${roadmap}&quot;.`],
      p.url,
      'Accept the invite',
      'The link works for 7 days. If you were not expecting this, you can ignore this email.',
    ),
  };
}

export function resetEmail(p: { url: string; expiresInMinutes: number }): EmailContent {
  const minutes = `${p.expiresInMinutes} minutes`;
  const footer = `The link works for ${minutes} and can be used once. If you did not ask for it, you can ignore this email.`;
  return {
    subject: 'Reset your password',
    text: ['Someone asked to reset the password for this account.', '', `Choose a new password: ${p.url}`, '', footer].join('\n'),
    html: layout(['Someone asked to reset the password for this account.'], p.url, 'Choose a new password', escapeHtml(footer)),
  };
}
