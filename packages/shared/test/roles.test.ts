import { describe, expect, test } from 'vitest';
import { ACTIONS, ROLES } from '../src/index.ts';

describe('shared roles and actions', () => {
  test('roles are owner, admin, contributor', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'contributor']);
  });

  test('actions are unique and cover the PRD table', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    expect(ACTIONS).toHaveLength(21);
  });
});
