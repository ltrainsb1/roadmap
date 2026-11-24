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
    expect(describeAuditEvent(event({ action: 'roadmap.delete' }), nameOf)).toBe('Maria made a change: roadmap.delete.');
  });

  test('ignores before and after values of the wrong shape', () => {
    expect(describeAuditEvent(event({ action: 'invite.create', after: 'oops' }), nameOf)).toBe('Maria invited someone as a member.');
    expect(describeAuditEvent(event({ action: 'member.role_change', before: null, after: {} }), nameOf)).toBe(
      "Maria changed Bob's role.",
    );
  });

  describe('project events', () => {
    const project = (action: Event['action'], over: Partial<Event> = {}) =>
      describeAuditEvent(event({ action, target: { type: 'project', id: 'p1' }, ...over }), nameOf);

    test('FR-1.8: project.create', () => {
      expect(project('project.create', { after: { title: 'Launch', parentId: null } })).toBe('Maria added Launch.');
    });

    test('FR-1.8: project.update', () => {
      expect(project('project.update', { before: { title: 'Old' }, after: { title: 'Launch' } })).toBe('Maria changed Launch.');
    });

    test('FR-1.8: project.delete names the item from before, so a deleted item is still named', () => {
      expect(project('project.delete', { before: { title: 'Launch', count: 3 } })).toBe('Maria deleted Launch.');
    });

    test('FR-1.8: project.archive and project.unarchive', () => {
      expect(project('project.archive', { after: { title: 'Launch', count: 1 } })).toBe('Maria archived Launch.');
      expect(project('project.unarchive', { after: { title: 'Launch', count: 1 } })).toBe('Maria unarchived Launch.');
    });

    test('FR-1.8: project.assign', () => {
      expect(project('project.assign', { before: { title: 'Launch', assigneeIds: [] }, after: { title: 'Launch', assigneeIds: ['u2'] } })).toBe(
        'Maria changed who is assigned to Launch.',
      );
    });

    test('FR-1.8: project.reorder names the parent, or says the projects for the top level', () => {
      expect(project('project.reorder', { after: { parentTitle: 'Season', orderedIds: ['a', 'b'] } })).toBe(
        'Maria reordered the items under Season.',
      );
      expect(project('project.reorder', { after: { parentTitle: null, orderedIds: ['a', 'b'] } })).toBe('Maria reordered the projects.');
    });

    test('FR-1.8: project.priority_label sets or removes the label', () => {
      expect(project('project.priority_label', { before: { title: 'Launch', priorityLabel: null }, after: { title: 'Launch', priorityLabel: 'P1' } })).toBe(
        'Maria set the priority label of Launch to P1.',
      );
      expect(project('project.priority_label', { before: { title: 'Launch', priorityLabel: 'P2' }, after: { title: 'Launch', priorityLabel: null } })).toBe(
        'Maria removed the priority label of Launch.',
      );
    });

    test('FR-1.8: an event without a stored title still reads as a sentence', () => {
      expect(project('project.create')).toBe('Maria added an item.');
      expect(project('project.delete', { before: 'oops' })).toBe('Maria deleted an item.');
    });
  });

  test('FR-1.5: note events say a note was added, edited or deleted, without its text', () => {
    const target = { type: 'note', id: 'n1' } as const;
    expect(describeAuditEvent(event({ action: 'note.create', target, after: { projectId: 'p1' } }), nameOf)).toBe('Maria added a note.');
    expect(describeAuditEvent(event({ action: 'note.update', target }), nameOf)).toBe('Maria edited a note.');
    expect(describeAuditEvent(event({ action: 'note.delete', target }), nameOf)).toBe('Maria deleted a note.');
  });

  test('FR-1.4: file events say a file was added, removed, or refused by the virus check', () => {
    const file = { type: 'attachment', id: 'a1' } as const;
    expect(describeAuditEvent(event({ action: 'attachment.create', target: file, after: { name: 'x.txt' } }), nameOf)).toBe('Maria added a file.');
    expect(describeAuditEvent(event({ action: 'attachment.delete', target: file }), nameOf)).toBe('Maria removed a file.');
    expect(describeAuditEvent(event({ action: 'attachment.rejected', target: { type: 'project', id: 'p1' } }), nameOf)).toBe(
      'Maria tried to add a file that failed the virus check.',
    );
  });

  test('FR-3.1: snapshot events say a snapshot was created, revoked, opened or locked, without its name or link', () => {
    const target = { type: 'snapshot', id: 's1' } as const;
    expect(describeAuditEvent(event({ action: 'snapshot.create', target, after: { name: 'Board pack' } }), nameOf)).toBe('Maria created a snapshot.');
    expect(describeAuditEvent(event({ action: 'snapshot.revoke', target, before: { name: 'Board pack' } }), nameOf)).toBe('Maria revoked a snapshot.');
    const system = { type: 'system' } as const;
    expect(describeAuditEvent(event({ action: 'snapshot.access', actor: system, target }), nameOf)).toBe('A snapshot was opened.');
    expect(describeAuditEvent(event({ action: 'snapshot.locked', actor: system, target }), nameOf)).toBe(
      'A snapshot link was locked after too many wrong passwords.',
    );
  });

  test('FR-5.2: user.notification_prefs says the person changed their email settings, without the choices', () => {
    const after = { prefs: { assigned: 'off', mentioned: 'instant', dates_changed: 'digest', due_soon: 'digest' } };
    expect(describeAuditEvent(event({ action: 'user.notification_prefs', target: { type: 'user', id: 'u1' }, after }), nameOf)).toBe(
      'Maria changed their email notification settings.',
    );
  });

  test('FR-4.2: user.calendar_feed says the person changed their calendar feed, without the choices', () => {
    const after = { change: 'choices', choices: { roadmaps: 'all', itemDates: true, milestones: false, onlyMine: true } };
    expect(describeAuditEvent(event({ action: 'user.calendar_feed', target: { type: 'user', id: 'u1' }, after }), nameOf)).toBe(
      'Maria changed their calendar feed.',
    );
  });
});
