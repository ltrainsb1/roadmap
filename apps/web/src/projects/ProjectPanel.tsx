import {
  can,
  LIMITS,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  projectWarnings,
  updateProjectRequestSchema,
  type PriorityLabel,
  type Project,
  type ProjectStatus,
  type Role,
} from '@roadmap/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { errorCode, errorMessage, GENERIC_ERROR, ITEM_READ_ONLY, itemActionMessage, messageFor } from '../api/errors.ts';
import { AttachmentsSection } from '../attachments/AttachmentsSection.tsx';
import { NotesSection } from '../notes/NotesSection.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { useFocusFirstError } from '../ui/useFocusFirstError.ts';
import { hasCalendarDates } from './calendarFile.ts';
import { isAssigned, useUpdateProject } from './useProjects.ts';
import { levelName, statusName, warningText } from './names.ts';
import { PanelLists, type ListValues, type MemberName } from './PanelLists.tsx';

interface FormValues extends ListValues {
  title: string;
  description: string;
  status: ProjectStatus;
  startDate: string;
  endDate: string;
}

const valuesOf = (item: Project): FormValues => ({
  title: item.title,
  description: item.description,
  status: item.status,
  startDate: item.startDate ?? '',
  endDate: item.endDate ?? '',
  tags: item.tags,
  links: item.links,
  milestones: item.milestones,
  blockedBy: item.blockedBy,
});

/** A change this browser saved through a route of its own (the row's status pill, assignees, the priority label). */
export interface OwnChange {
  id: string;
  /** The item's version after the change. */
  version: number;
  /** Set only by a status change, whose new value the form takes; the others show their value straight from the list. */
  status?: ProjectStatus;
  /** Counts up with every change, so the panel notices each one. */
  n: number;
}

interface PanelProps {
  roadmapId: string;
  role: Role;
  /** The signed-in person, to decide whether the fields can be edited. */
  myId: string | undefined;
  item: Project;
  byId: ReadonlyMap<string, Project>;
  /** Where the "Back to projects" link goes: the list. */
  listPath: string;
  /** Called when the panel asks to close, from the Close button or Escape. */
  onClose: () => void;
  /** Refetches the list and gives back the fresh item, or undefined if it is gone. */
  onReload: () => Promise<Project | undefined>;
  /** The roadmap's members, to assign. */
  members: readonly MemberName[];
  /** The newest save of this item made outside the form, if any; the form adopts its version so Save does not conflict with it. */
  ownChange: OwnChange | undefined;
  /** Ticks or unticks one member; saves at once and the page shows any error. */
  onToggleAssignee: (itemId: string, userId: string, assigned: boolean) => void;
  /** Sets the priority label; saves at once and the page shows any error. */
  onSetPriorityLabel: (itemId: string, label: PriorityLabel | null) => void;
  /** Tells the page whether the form, or a note box, has changes that are not saved. */
  onDirtyChange: (dirty: boolean) => void;
  /** Downloads the item's saved dates as a calendar file; the page shows any error (FR-4.5). */
  onAddToCalendar: (item: Project) => void;
  /** The signed-in person's time zone, for the times on notes and files. */
  timeZone: string;
}

/**
 * The panel beside the list for editing one item's core fields. Its form starts from the item when the panel
 * opens (the page keys it by item id) and is not touched by later refetches, so nothing typed is lost. Save
 * sends the version the form was started from, so a change made by someone else is a conflict, never overwritten.
 */
export function ProjectPanel({ roadmapId, role, myId, item, byId, listPath, onClose, onReload, members, ownChange, onToggleAssignee, onSetPriorityLabel, onDirtyChange, onAddToCalendar, timeZone }: PanelProps) {
  const update = useUpdateProject(roadmapId);
  const [values, setValues] = useState(() => valuesOf(item));
  // What the form was last started or saved from, to tell whether anything is unsaved.
  const [base, setBase] = useState(values);
  const [reloaded, setReloaded] = useState(0);
  const [version, setVersion] = useState(item.version);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; endDate?: string }>({});
  const [formError, setFormError] = useState<{ code: string; message: string } | undefined>();
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const headingId = useId();

  const editable = can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } });
  const parent = item.parentId ? byId.get(item.parentId) : undefined;
  const warnings = projectWarnings(item, byId).map((w) => warningText(w, byId));

  // Opening the panel (or a different item) moves focus into it.
  useEffect(() => heading.current?.focus(), []);

  // Text typed in a note box counts as unsaved too.
  const [noteDraft, setNoteDraft] = useState(false);
  const dirty = noteDraft || JSON.stringify(values) !== JSON.stringify(base);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  // This browser's own change made outside the form: take its version, and its status if it set one, and keep
  // everything else typed. Changes made elsewhere are deliberately not adopted, so Save still reports them as a conflict.
  const adopted = useRef(ownChange?.n);
  useEffect(() => {
    if (!ownChange || ownChange.n === adopted.current) return;
    adopted.current = ownChange.n;
    if (ownChange.id !== item.id) return;
    // Only when nothing else landed in between: otherwise the form would save against a version it never saw.
    if (ownChange.version !== version + 1) return;
    setVersion(ownChange.version);
    const { status } = ownChange;
    if (status) {
      setValues((v) => ({ ...v, status }));
      setBase((b) => ({ ...b, status }));
    }
  }, [ownChange, item.id, version]);

  // After a reload the Reload button is gone, so focus goes to the first field.
  useEffect(() => {
    if (reloaded > 0) document.getElementById(`panel-${item.id}-title`)?.focus();
  }, [reloaded, item.id]);
  useFocusFirstError(form, attempt);

  const change = (patch: Partial<FormValues>) => {
    setValues((v) => ({ ...v, ...patch }));
    setSaved(false);
  };

  const fail = (fields: typeof fieldErrors, error?: typeof formError) => {
    setFieldErrors(fields);
    setFormError(error);
    setSaved(false);
    setAttempt((n) => n + 1);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (update.isPending) return;
    const body = {
      version,
      title: values.title,
      description: values.description,
      status: values.status,
      startDate: values.startDate || null,
      endDate: values.endDate || null,
      tags: values.tags,
      // Kept entries go back with their ids, new ones without.
      links: values.links.map(({ id: linkId, label, url }) => ({ ...(linkId && { id: linkId }), label, url })),
      milestones: values.milestones.map(({ id: milestoneId, name, date }) => ({ ...(milestoneId && { id: milestoneId }), name, date })),
      blockedBy: values.blockedBy,
    };
    const checked = updateProjectRequestSchema.safeParse(body);
    if (!checked.success) {
      const issue = (key: string) => checked.error.issues.find((i) => i.path[0] === key);
      const fields: typeof fieldErrors = {};
      if (issue('title')) fields.title = 'Enter a title.';
      if (issue('endDate')?.message === 'date_order') fields.endDate = errorMessage('date_order');
      fail(fields, Object.keys(fields).length === 0 ? { code: 'unknown', message: GENERIC_ERROR } : undefined);
      return;
    }
    setFieldErrors({});
    setFormError(undefined);
    try {
      const next = await update.mutateAsync({ projectId: item.id, body: checked.data });
      setValues(valuesOf(next));
      setBase(valuesOf(next));
      setVersion(next.version);
      setSaved(true);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'date_order') return fail({ endDate: messageFor(err) });
      fail({}, { code, message: itemActionMessage(err) });
      // Gone, or no longer theirs to change: the refetched list replaces a gone item's panel with the missing-item
      // message and turns a forbidden one read-only. The form keeps what was typed, and the alert says why.
      if (code === 'not_found' || code === 'forbidden') void onReload().catch(() => undefined);
    }
  };

  const reload = async () => {
    try {
      const fresh = await onReload();
      if (!fresh) return;
      setValues(valuesOf(fresh));
      setBase(valuesOf(fresh));
      setVersion(fresh.version);
      setReloaded((n) => n + 1);
      setFieldErrors({});
      setFormError(undefined);
      setSaved(false);
    } catch (err) {
      fail({}, { code: errorCode(err), message: messageFor(err) });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  };

  const id = (name: string) => `panel-${item.id}-${name}`;
  const canSetPriority = can({ role, action: 'project.setPriority' });
  const canAssign = can({ role, action: 'project.assign' });

  return (
    <section className="project-panel" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <Link
        to={listPath}
        className="text-link panel-back"
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        Back to projects
      </Link>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        {item.title}
      </h2>
      <p className="hint panel-level">{parent ? `${levelName(item.depth)} in ${parent.title}` : levelName(item.depth)}</p>

      {warnings.length > 0 && (
        <ul className="panel-warnings">
          {warnings.map((text) => (
            <li key={text}>
              <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M8 6.5v3.5M8 11.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* After a refused Save the alert already says this. */}
      {!editable && formError?.code !== 'forbidden' && <p>{ITEM_READ_ONLY}</p>}

      {formError && (
        <Alert>
          <p>{formError.message}</p>
          {formError.code === 'conflict' && <Button onClick={() => void reload()}>Reload</Button>}
        </Alert>
      )}

      <form ref={form} onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id={id('title')}
          label="Title"
          value={values.title}
          maxLength={LIMITS.title}
          readOnly={!editable}
          error={fieldErrors.title}
          onChange={(e) => change({ title: e.target.value })}
        />
        <div className="field">
          <label htmlFor={id('description')}>Description</label>
          <textarea
            id={id('description')}
            rows={5}
            value={values.description}
            maxLength={LIMITS.description}
            readOnly={!editable}
            onChange={(e) => change({ description: e.target.value })}
          />
        </div>
        <SelectField
          id={id('status')}
          label="Status"
          value={values.status}
          disabled={!editable}
          onChange={(e) => change({ status: e.target.value as ProjectStatus })}
        >
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusName(s)}
            </option>
          ))}
        </SelectField>
        <Field
          id={id('start')}
          label="Start date"
          type="date"
          value={values.startDate}
          readOnly={!editable}
          onChange={(e) => change({ startDate: e.target.value })}
        />
        <Field
          id={id('end')}
          label="End date"
          type="date"
          value={values.endDate}
          readOnly={!editable}
          error={fieldErrors.endDate}
          onChange={(e) => change({ endDate: e.target.value })}
        />
        {/* From the saved item, which is what the server's file holds. */}
        {hasCalendarDates(item) && (
          <p className="panel-calendar">
            <Button variant="link" onClick={() => onAddToCalendar(item)}>
              Add to calendar
            </Button>
          </p>
        )}
        <SelectField
          id={id('label')}
          label="Priority label"
          value={item.priorityLabel ?? ''}
          disabled={!canSetPriority}
          onChange={(e) => onSetPriorityLabel(item.id, (e.target.value || null) as PriorityLabel | null)}
        >
          <option value="">None</option>
          {PRIORITY_LABELS.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </SelectField>
        <PanelLists
          idPrefix={`panel-${item.id}`}
          item={item}
          byId={byId}
          members={members}
          values={values}
          onChange={change}
          editable={editable}
          canAssign={canAssign}
          onToggleAssignee={(userId, assigned) => onToggleAssignee(item.id, userId, assigned)}
        />
        <div className="panel-actions">
          {editable && (
            <Button type="submit" variant="primary">
              Save
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </div>
        <div role="status" className="saved">
          {saved ? 'Saved.' : ''}
        </div>
      </form>
      <AttachmentsSection roadmapId={roadmapId} item={item} editable={editable} timeZone={timeZone} />
      <NotesSection
        roadmapId={roadmapId}
        item={item}
        role={role}
        myId={myId}
        members={members}
        timeZone={timeZone}
        onDraftChange={setNoteDraft}
      />
    </section>
  );
}
