import type { AuditPage } from '@roadmap/shared';
import { describe, expect, test } from 'vitest';
import { describeAuditEvent } from './describe.ts';

type Event = AuditPage['items'][number];

const NAMES: Record<string, string> = { u2: 'Bob', u3: 'Cleo' };
const nameOf = (id: string) => NAMES[id];

const event = (over: Partial<Event> & Pick<Event, 'action'>): Event => ({
  id: 'e1',
  timestamp: '2026-11-18T10:00:00.000Z',
  actor: { type: 'user', userId: 'u1', name: 'Maria' },
  target: { type: 'user', id: 'u2' },
  ip: null,
  ...over,
});

describe('describeAuditEvent', () => {
  test('roadmap.create', () => {
    expect(describeAuditEvent(event({ action: 'roadmap.create', after: { name: 'Launch plan' } }), nameOf)).toBe(
      'Maria created the roadmap "Launch plan".',
    );
    expect(describeAuditEvent(event({ action: 'roadmap.create' }), nameOf)).toBe('Maria created the roadmap.');
  });

  test('roadmap.transfer', () => {
    expect(describeAuditEvent(event({ action: 'roadmap.transfer', after: { ownerId: 'u2' } }), nameOf)).toBe(
      'Maria transferred ownership to Bob.',
    );
    expect(describeAuditEvent(event({ action: 'roadmap.transfer', after: { ownerId: 'gone' } }), nameOf)).toBe(
      'Maria transferred ownership to a former member.',
    );
  });

  test('invite.create', () => {
    expect(
      describeAuditEvent(event({ action: 'invite.create', after: { email: 'bob@example.com', role: 'contributor' } }), nameOf),
    ).toBe('Maria invited bob@example.com as Contributor.');
  });

  test('invite.accept', () => {
    expect(
      describeAuditEvent(event({ action: 'invite.accept', after: { email: 'bob@example.com', role: 'admin' } }), nameOf),
    ).toBe('Maria accepted an invite and joined as Admin.');
  });

  test('invite.revoke', () => {
    expect(
      describeAuditEvent(event({ action: 'invite.revoke', before: { email: 'bob@example.com', role: 'admin' } }), nameOf),
    ).toBe('Maria revoked the invite for bob@example.com.');
  });

  test('member.role_change', () => {
    expect(
      describeAuditEvent(
        event({ action: 'member.role_change', before: { role: 'contributor' }, after: { role: 'admin' } }),
        nameOf,
      ),
    ).toBe("Maria changed Bob's role from Contributor to Admin.");
  });

  test('member.remove', () => {
    expect(describeAuditEvent(event({ action: 'member.remove', before: { role: 'admin' } }), nameOf)).toBe(
      'Maria removed Bob from the roadmap.',
    );
    expect(
      describeAuditEvent(event({ action: 'member.remove', target: { type: 'user', id: 'gone' } }), nameOf),
    ).toBe('Maria removed a former member from the roadmap.');
  });

  test('a user who no longer exists reads as a former member', () => {
    const actor = { type: 'user', userId: 'x', name: null } as const;
    expect(describeAuditEvent(event({ action: 'member.remove', actor }), nameOf)).toBe(
      'A former member removed Bob from the roadmap.',
    );
  });

  test('system and unknown actions still read as a sentence', () => {
    expect(describeAuditEvent(event({ action: 'roadmap.create', actor: { type: 'system' } }), nameOf)).toBe(
      'The system created the roadmap.',
    );
    expect(describeAuditEvent(event({ action: 'project.archive' }), nameOf)).toBe('Maria made a change: project.archive.');
  });

  test('ignores before and after values of the wrong shape', () => {
    expect(describeAuditEvent(event({ action: 'invite.create', after: 'oops' }), nameOf)).toBe('Maria invited someone as a member.');
    expect(describeAuditEvent(event({ action: 'member.role_change', before: null, after: {} }), nameOf)).toBe(
      "Maria changed Bob's role.",
    );
  });
});
