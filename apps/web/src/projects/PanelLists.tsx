import { buildTree, LIMITS, linkSchema, milestoneSchema, tagSchema, wouldCycle, type Project, type TreeNode } from '@roadmap/shared';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { focusRemaining } from './focusAfterRemove.ts';
import { formatDay } from './names.ts';

/** A link in the form; `id` is set once it is saved, and a new one has none. */
export interface LinkEntry {
  id?: string;
  label: string;
  url: string;
}
export interface MilestoneEntry {
  id?: string;
  name: string;
  date: string;
}
/** The panel's list fields, which are part of its form and save with "Save". */
export interface ListValues {
  tags: string[];
  links: LinkEntry[];
  milestones: MilestoneEntry[];
  blockedBy: string[];
}

export interface MemberName {
  userId: string;
  name: string;
  /** Shown in the @ list to tell apart two members with the same name. */
  email?: string;
}

interface PanelListsProps {
  /** Prefix for element ids, so two panels never share one. */
  idPrefix: string;
  item: Project;
  byId: ReadonlyMap<string, Project>;
  members: readonly MemberName[];
  values: ListValues;
  onChange: (patch: Partial<ListValues>) => void;
  /** Whether tags, links, milestones and blocked by can be changed. */
  editable: boolean;
  /** Whether assignees can be changed; they save as soon as a box is ticked. */
  canAssign: boolean;
  onToggleAssignee: (userId: string, assigned: boolean) => void;
}

const REMOVE_ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

function RemoveButton({ label, list, onRemove }: { label: string; list: string; onRemove: () => void }) {
  return (
    <button type="button" className="icon-btn" data-list={list} aria-label={label} onClick={onRemove}>
      {REMOVE_ICON}
    </button>
  );
}

/** Enter in a draft field adds the entry instead of saving the whole form. */
const onEnter = (add: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  add();
};

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="panel-group">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** The non-archived items in tree order with their depth, for the "blocked by" choices. */
function flatten(nodes: TreeNode[], out: Project[] = []): Project[] {
  for (const node of nodes) {
    out.push(node.item);
    flatten(node.children, out);
  }
  return out;
}

/** Assignees, tags, links, milestones and "blocked by" for the open item. */
export function PanelLists({ idPrefix, item, byId, members, values, onChange, editable, canAssign, onToggleAssignee }: PanelListsProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState<string | undefined>();
  const [link, setLink] = useState({ label: '', url: '' });
  const [linkError, setLinkError] = useState<string | undefined>();
  const [milestone, setMilestone] = useState({ name: '', date: '' });
  const [milestoneError, setMilestoneError] = useState<string | undefined>();
  const blockedId = useId();
  // The "blocked by" choice waits here until "Add item": a closed select fires change on every arrow key on some platforms.
  const [blocker, setBlocker] = useState('');
  const [blockerError, setBlockerError] = useState<string | undefined>();
  const blockerSelect = useRef<HTMLSelectElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Where focus goes once the list has re-rendered, because the control that held it is gone or hidden.
  const refocus = useRef<{ list: string; index: number; fallbackId: string } | null>(null);
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target && root.current) focusRemaining(root.current, target.list, target.index, target.fallbackId);
  }, [values]);
  /** Removes entry `index` of `list` and keeps focus in that list. */
  const removeFrom = (list: string, index: number, fallbackId: string, patch: Partial<ListValues>) => {
    refocus.current = { list, index, fallbackId };
    onChange(patch);
  };
  /** After adding, a full list hides its add controls; focus goes to the last entry's remove button. */
  const afterAdd = (list: string, count: number, max: number, fallbackId: string) => {
    if (count >= max) refocus.current = { list, index: count - 1, fallbackId };
  };

  const addTag = () => {
    const parsed = tagSchema.safeParse(tag);
    if (!parsed.success) return setTagError('Enter a tag.');
    setTagError(undefined);
    setTag('');
    if (!values.tags.includes(parsed.data)) {
      afterAdd('tags', values.tags.length + 1, LIMITS.tags, id('tag'));
      onChange({ tags: [...values.tags, parsed.data] });
    }
  };

  const addLink = () => {
    const parsed = linkSchema.omit({ id: true }).safeParse(link);
    if (!parsed.success) return setLinkError('Enter an address that starts with http:// or https://.');
    setLinkError(undefined);
    setLink({ label: '', url: '' });
    afterAdd('links', values.links.length + 1, LIMITS.links, id('link-label'));
    onChange({ links: [...values.links, parsed.data] });
  };

  const addMilestone = () => {
    const parsed = milestoneSchema.omit({ id: true }).safeParse(milestone);
    if (!parsed.success) return setMilestoneError('Enter a name and a date.');
    setMilestoneError(undefined);
    setMilestone({ name: '', date: '' });
    afterAdd('milestones', values.milestones.length + 1, LIMITS.milestones, id('milestone-name'));
    onChange({ milestones: [...values.milestones, parsed.data] });
  };

  // Not offered: the item, anything above or below it, anything already chosen, and anything that would make a cycle.
  const choices = useMemo(() => {
    const open = [...byId.values()].filter((i) => !i.archived);
    return flatten(buildTree(open)).filter(
      (i) => i.id !== item.id && !item.path.includes(i.id) && !i.path.includes(item.id) && !values.blockedBy.includes(i.id) && !wouldCycle(item.id, [i.id], byId),
    );
  }, [byId, item.id, item.path, values.blockedBy]);

  const addBlocker = () => {
    // A choice the list no longer offers (a refetch made it a cycle, say) counts as no choice.
    if (!choices.some((c) => c.id === blocker)) return setBlockerError('Choose an item.');
    setBlockerError(undefined);
    setBlocker('');
    const count = values.blockedBy.length + 1;
    afterAdd('blocked', count, LIMITS.blockedBy, blockedId);
    onChange({ blockedBy: [...values.blockedBy, blocker] });
    // The select stays for the next choice, unless the list is now full and hides it.
    if (count < LIMITS.blockedBy) blockerSelect.current?.focus();
  };

  const assigned = item.assigneeIds.map((userId) => members.find((m) => m.userId === userId)?.name).filter((n): n is string => n !== undefined);

  return (
    <div ref={root}>
      <Group legend="Assignees">
        {canAssign ? (
          members.map((m) => (
            <div className="check" key={m.userId}>
              <input
                id={id(`assignee-${m.userId}`)}
                type="checkbox"
                checked={item.assigneeIds.includes(m.userId)}
                onChange={(e) => onToggleAssignee(m.userId, e.target.checked)}
              />
              <label htmlFor={id(`assignee-${m.userId}`)}>{m.name}</label>
            </div>
          ))
        ) : (
          <p>{assigned.length > 0 ? assigned.join(', ') : 'Unassigned'}</p>
        )}
      </Group>

      <Group legend="Tags">
        {values.tags.length > 0 && (
          <ul className="entry-list">
            {values.tags.map((t) => (
              <li key={t}>
                <span className="pill">{t}</span>
                {editable && <RemoveButton label={`Remove tag ${t}`} list="tags" onRemove={() => removeFrom('tags', values.tags.indexOf(t), id('tag'), { tags: values.tags.filter((x) => x !== t) })} />}
              </li>
            ))}
          </ul>
        )}
        {editable && values.tags.length < LIMITS.tags && (
          <div className="add-entry">
            <Field
              id={id('tag')}
              label="Add a tag"
              value={tag}
              maxLength={LIMITS.tagLength}
              autoComplete="off"
              error={tagError}
              onChange={(e) => {
                setTag(e.target.value);
                setTagError(undefined);
              }}
              onKeyDown={onEnter(addTag)}
            />
            <Button onClick={addTag}>Add</Button>
          </div>
        )}
      </Group>

      <Group legend="Links">
        {values.links.length > 0 && (
          <ul className="entry-list">
            {values.links.map((l, index) => (
              <li key={`${l.id ?? 'new'}-${index}`}>
                <a href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.label || l.url}
                </a>
                {editable && <RemoveButton label={`Remove link ${l.label || l.url}`} list="links" onRemove={() => removeFrom('links', index, id('link-label'), { links: values.links.filter((_, i) => i !== index) })} />}
              </li>
            ))}
          </ul>
        )}
        {editable && values.links.length < LIMITS.links && (
          <div className="add-entry add-entry-stack">
            <Field
              id={id('link-label')}
              label="Label"
              value={link.label}
              maxLength={LIMITS.linkLabel}
              autoComplete="off"
              onChange={(e) => setLink((l) => ({ ...l, label: e.target.value }))}
              onKeyDown={onEnter(addLink)}
            />
            <Field
              id={id('link-url')}
              label="Address"
              value={link.url}
              maxLength={LIMITS.linkUrl}
              autoComplete="off"
              error={linkError}
              onChange={(e) => {
                setLink((l) => ({ ...l, url: e.target.value }));
                setLinkError(undefined);
              }}
              onKeyDown={onEnter(addLink)}
            />
            <Button onClick={addLink}>Add link</Button>
          </div>
        )}
      </Group>

      <Group legend="Milestones">
        {values.milestones.length > 0 && (
          <ul className="entry-list">
            {values.milestones.map((m, index) => (
              <li key={`${m.id ?? 'new'}-${index}`}>
                <span>
                  {m.name} ({formatDay(m.date)})
                </span>
                {editable && <RemoveButton label={`Remove milestone ${m.name}`} list="milestones" onRemove={() => removeFrom('milestones', index, id('milestone-name'), { milestones: values.milestones.filter((_, i) => i !== index) })} />}
              </li>
            ))}
          </ul>
        )}
        {editable && values.milestones.length < LIMITS.milestones && (
          <div className="add-entry add-entry-stack">
            <Field
              id={id('milestone-name')}
              label="Name"
              value={milestone.name}
              maxLength={LIMITS.milestoneName}
              autoComplete="off"
              onChange={(e) => setMilestone((m) => ({ ...m, name: e.target.value }))}
              onKeyDown={onEnter(addMilestone)}
            />
            <Field
              id={id('milestone-date')}
              label="Date"
              type="date"
              value={milestone.date}
              error={milestoneError}
              onChange={(e) => {
                setMilestone((m) => ({ ...m, date: e.target.value }));
                setMilestoneError(undefined);
              }}
              onKeyDown={onEnter(addMilestone)}
            />
            <Button onClick={addMilestone}>Add milestone</Button>
          </div>
        )}
      </Group>

      <Group legend="Blocked by">
        {values.blockedBy.length > 0 && (
          <ul className="entry-list">
            {values.blockedBy.map((blockerId, index) => {
              const blocker = byId.get(blockerId);
              return (
                <li key={blockerId}>
                  <span>
                    {blocker?.title ?? 'Deleted item'}
                    {blocker?.archived && <span className="hint"> Archived</span>}
                  </span>
                  {editable && (
                    <RemoveButton
                      label={`Remove ${blocker?.title ?? 'Deleted item'}`}
                      list="blocked"
                      onRemove={() => removeFrom('blocked', index, blockedId, { blockedBy: values.blockedBy.filter((x) => x !== blockerId) })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editable && values.blockedBy.length < LIMITS.blockedBy && (
          <div className="add-entry">
            <SelectField
              id={blockedId}
              ref={blockerSelect}
              label="Add an item this is blocked by"
              value={blocker}
              error={blockerError}
              onChange={(e) => {
                setBlocker(e.target.value);
                setBlockerError(undefined);
              }}
            >
              <option value="">Choose an item</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {'\u00a0\u00a0'.repeat(c.depth - 1)}
                  {c.title}
                </option>
              ))}
            </SelectField>
            <Button onClick={addBlocker}>Add item</Button>
          </div>
        )}
      </Group>
    </div>
  );
}
