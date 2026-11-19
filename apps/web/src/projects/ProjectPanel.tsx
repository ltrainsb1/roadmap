import {
  can,
  LIMITS,
  PROJECT_STATUSES,
  projectWarnings,
  updateProjectRequestSchema,
  type Project,
  type ProjectStatus,
  type Role,
} from '@roadmap/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { errorCode, errorMessage, GENERIC_ERROR, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { useFocusFirstError } from '../ui/useFocusFirstError.ts';
import { isAssigned, useUpdateProject } from './useProjects.ts';
import { levelName, statusName, warningText } from './names.ts';

interface FormValues {
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
});

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
  /** Called when "Back to projects" is chosen, so the page can hand focus back to the row. */
  onBack: () => void;
}

/**
 * The panel beside the list for editing one item's core fields. Its form starts from the item when the panel
 * opens (the page keys it by item id) and is not touched by later refetches, so nothing typed is lost. Save
 * sends the version the form was started from, so a change made by someone else is a conflict, never overwritten.
 */
export function ProjectPanel({ roadmapId, role, myId, item, byId, listPath, onClose, onReload, onBack }: PanelProps) {
  const update = useUpdateProject(roadmapId);
  const [values, setValues] = useState(() => valuesOf(item));
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
      setVersion(next.version);
      setSaved(true);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'date_order') fail({ endDate: messageFor(err) });
      else fail({}, { code, message: messageFor(err) });
    }
  };

  const reload = async () => {
    try {
      const fresh = await onReload();
      if (!fresh) return;
      setValues(valuesOf(fresh));
      setVersion(fresh.version);
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

  return (
    <section className="project-panel" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <Link to={listPath} className="text-link panel-back" onClick={onBack}>
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

      {!editable && <p>Only people assigned to this item, Owners and Admins can change it.</p>}

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
    </section>
  );
}
