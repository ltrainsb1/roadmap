import type { Action, Role } from './roles.ts';

export interface PolicyContext {
  isAssigned?: boolean;
  targetRole?: Role;
  newRole?: Role;
}

type Rule = (role: Role, ctx: PolicyContext) => boolean;

const everyone: Rule = () => true;
const staff: Rule = (role) => role !== 'contributor';
const ownerOnly: Rule = (role) => role === 'owner';
// Contributors act only on projects assigned to them.
const staffOrAssigned: Rule = (role, ctx) => role !== 'contributor' || ctx.isAssigned === true;

// Ownership moves only by transfer, so 'owner' is never an acceptable member target.
const isManageable = (r: Role | undefined) => r === 'admin' || r === 'contributor';
const memberRule = (...needs: Array<'targetRole' | 'newRole'>): Rule => (role, ctx) =>
  staff(role, ctx) && needs.every((k) => isManageable(ctx[k]));

const RULES: Record<Action, Rule> = {
  'roadmap.view': everyone,
  'idea.submit': everyone,
  'vote.cast': everyone,
  'comment.create': everyone,
  'ai.use': everyone,
  'project.create': staffOrAssigned,
  'project.edit': staffOrAssigned,
  'project.delete': staffOrAssigned,
  'project.setPriority': staff,
  'project.assign': staff,
  'idea.convert': staff,
  'snapshot.create': staff,
  'audit.view': staff,
  'member.invite': memberRule('newRole'),
  'member.remove': memberRule('targetRole'),
  'member.changeRole': memberRule('targetRole', 'newRole'),
  'roadmap.delete': ownerOnly,
  'roadmap.transfer': ownerOnly,
};

/** Pure permission check. Denies when there is no role, the action is unknown, or required context is missing. */
export function can(input: { role: Role | null; action: Action; ctx?: PolicyContext }): boolean {
  const { role, action, ctx = {} } = input;
  if (role === null) return false;
  const rule = Object.hasOwn(RULES, action) ? RULES[action] : undefined;
  return rule ? rule(role, ctx) : false;
}

const ROLE_VALUES: ReadonlyArray<Role | undefined> = [undefined, 'owner', 'admin', 'contributor'];

/** True when some context could make `can` allow this role; false means no request body can change the answer. */
export function canEver(role: Role | null, action: Action): boolean {
  for (const isAssigned of [undefined, true, false]) {
    for (const targetRole of ROLE_VALUES) {
      for (const newRole of ROLE_VALUES) {
        const ctx: PolicyContext = {
          ...(isAssigned !== undefined && { isAssigned }),
          ...(targetRole !== undefined && { targetRole }),
          ...(newRole !== undefined && { newRole }),
        };
        if (can({ role, action, ctx })) return true;
      }
    }
  }
  return false;
}
