import { describe, expect, test } from 'vitest';
import { ACTIONS, ROLES, type Action, type Role } from '../src/roles.ts';
import { can, canEver } from '../src/policy.ts';

const ALL: readonly Role[] = ROLES;
const everyone: Action[] = [
  'roadmap.view',
  'idea.submit',
  'vote.cast',
  'comment.create',
  'ai.use',
  'note.create',
];
const assignedOnly: Action[] = ['project.create', 'project.edit', 'project.delete'];
const staff: Action[] = [
  'project.setPriority',
  'project.assign',
  'idea.convert',
  'snapshot.create',
  'audit.view',
];
const ownerOnly: Action[] = ['roadmap.delete', 'roadmap.transfer'];

describe('Permissions table (PRD Users and roles)', () => {
  test.each(everyone)('%s is allowed for every role', (action) => {
    for (const role of ALL) expect(can({ role, action })).toBe(true);
  });

  test.each(assignedOnly)('%s: owner and admin yes, contributor only when assigned', (action) => {
    expect(can({ role: 'owner', action })).toBe(true);
    expect(can({ role: 'admin', action })).toBe(true);
    expect(can({ role: 'contributor', action })).toBe(false);
    expect(can({ role: 'contributor', action, ctx: {} })).toBe(false);
    expect(can({ role: 'contributor', action, ctx: { isAssigned: false } })).toBe(false);
    expect(can({ role: 'contributor', action, ctx: { isAssigned: true } })).toBe(true);
  });

  test.each(staff)('%s: owner and admin yes, contributor never', (action) => {
    expect(can({ role: 'owner', action })).toBe(true);
    expect(can({ role: 'admin', action })).toBe(true);
    expect(can({ role: 'contributor', action })).toBe(false);
    expect(can({ role: 'contributor', action, ctx: { isAssigned: true } })).toBe(false);
  });

  test.each(ownerOnly)('%s: owner only', (action) => {
    expect(can({ role: 'owner', action })).toBe(true);
    expect(can({ role: 'admin', action })).toBe(false);
    expect(can({ role: 'contributor', action })).toBe(false);
  });

  test('note.edit: allowed for every role only for the author', () => {
    for (const role of ALL) {
      expect(can({ role, action: 'note.edit' })).toBe(false);
      expect(can({ role, action: 'note.edit', ctx: { isAuthor: false } })).toBe(false);
      expect(can({ role, action: 'note.edit', ctx: { isAuthor: true } })).toBe(true);
    }
  });

  test('note.delete: owner and admin always, contributor only for their own note', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(can({ role, action: 'note.delete' })).toBe(true);
      expect(can({ role, action: 'note.delete', ctx: { isAuthor: false } })).toBe(true);
      expect(can({ role, action: 'note.delete', ctx: { isAuthor: true } })).toBe(true);
    }
    expect(can({ role: 'contributor', action: 'note.delete' })).toBe(false);
    expect(
      can({
        role: 'contributor',
        action: 'note.delete',
        ctx: { isAuthor: false },
      }),
    ).toBe(false);
    expect(
      can({
        role: 'contributor',
        action: 'note.delete',
        ctx: { isAuthor: true },
      }),
    ).toBe(true);
  });

  test('canEver sees author context for notes', () => {
    expect(canEver('contributor', 'note.edit')).toBe(true);
    expect(canEver('contributor', 'note.delete')).toBe(true);
  });

  test('member.invite: owner may invite admin or contributor, admin likewise, contributor never', () => {
    for (const newRole of ['admin', 'contributor'] as const) {
      expect(can({ role: 'owner', action: 'member.invite', ctx: { newRole } })).toBe(true);
      expect(can({ role: 'admin', action: 'member.invite', ctx: { newRole } })).toBe(true);
      expect(can({ role: 'contributor', action: 'member.invite', ctx: { newRole } })).toBe(false);
    }
  });

  test('member.invite with newRole owner is denied for every role', () => {
    for (const role of ALL) {
      expect(can({ role, action: 'member.invite', ctx: { newRole: 'owner' } })).toBe(false);
    }
  });

  test.each(['member.remove', 'member.changeRole'] as const)(
    '%s with targetRole owner is denied for every role',
    (action) => {
      for (const role of ALL) {
        expect(can({ role, action, ctx: { targetRole: 'owner', newRole: 'admin' } })).toBe(false);
      }
    },
  );

  test('member.remove: owner and admin may remove admin or contributor, contributor never', () => {
    for (const targetRole of ['admin', 'contributor'] as const) {
      expect(can({ role: 'owner', action: 'member.remove', ctx: { targetRole } })).toBe(true);
      expect(can({ role: 'admin', action: 'member.remove', ctx: { targetRole } })).toBe(true);
      expect(can({ role: 'contributor', action: 'member.remove', ctx: { targetRole } })).toBe(false);
    }
  });

  test('member.changeRole needs both roles to be admin or contributor', () => {
    const ctx = { targetRole: 'contributor', newRole: 'admin' } as const;
    expect(can({ role: 'owner', action: 'member.changeRole', ctx })).toBe(true);
    expect(can({ role: 'admin', action: 'member.changeRole', ctx })).toBe(true);
    expect(can({ role: 'contributor', action: 'member.changeRole', ctx })).toBe(false);
    expect(
      can({ role: 'owner', action: 'member.changeRole', ctx: { targetRole: 'admin', newRole: 'owner' } }),
    ).toBe(false);
  });

  test('member.* with a missing required role fails closed', () => {
    for (const role of ALL) {
      expect(can({ role, action: 'member.invite' })).toBe(false);
      expect(can({ role, action: 'member.invite', ctx: { targetRole: 'admin' } })).toBe(false);
      expect(can({ role, action: 'member.remove' })).toBe(false);
      expect(can({ role, action: 'member.remove', ctx: { newRole: 'admin' } })).toBe(false);
      expect(can({ role, action: 'member.changeRole' })).toBe(false);
      expect(can({ role, action: 'member.changeRole', ctx: { targetRole: 'admin' } })).toBe(false);
      expect(can({ role, action: 'member.changeRole', ctx: { newRole: 'admin' } })).toBe(false);
    }
  });

  test('role null is denied for every action', () => {
    for (const action of ACTIONS) {
      expect(can({ role: null, action, ctx: { isAssigned: true, isAuthor: true, targetRole: 'admin', newRole: 'admin' } })).toBe(
        false,
      );
    }
  });

  test('an unknown action is denied', () => {
    expect(can({ role: 'owner', action: 'nope' as Action })).toBe(false);
  });
});

describe('canEver', () => {
  test('is true when some context lets the role act, false when none can', () => {
    expect(canEver('contributor', 'project.edit')).toBe(true); // when assigned
    expect(canEver('contributor', 'member.invite')).toBe(false);
    expect(canEver('admin', 'member.changeRole')).toBe(true);
    expect(canEver('admin', 'roadmap.delete')).toBe(false);
    expect(canEver('owner', 'roadmap.transfer')).toBe(true);
    expect(canEver(null, 'roadmap.view')).toBe(false);
  });
});
