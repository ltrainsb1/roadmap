export const ROLES = ['owner', 'admin', 'contributor'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  'roadmap.view',
  'project.create',
  'project.edit',
  'project.delete',
  'project.setPriority',
  'project.assign',
  'idea.submit',
  'vote.cast',
  'comment.create',
  'idea.convert',
  'snapshot.create',
  'member.invite',
  'member.remove',
  'member.changeRole',
  'roadmap.delete',
  'roadmap.transfer',
  'ai.use',
  'audit.view',
] as const;
export type Action = (typeof ACTIONS)[number];
