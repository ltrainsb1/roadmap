import type { Ref, SelectHTMLAttributes } from 'react';
import { ErrorIcon } from './Field.tsx';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: string;
  error?: string | undefined;
  ref?: Ref<HTMLSelectElement>;
}

/** A visible label above a native select, and an error under it that the select points to. */
export function SelectField({ id, label, error, children, ref, ...select }: SelectFieldProps) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} ref={ref} aria-invalid={error ? true : undefined} aria-describedby={errorId} {...select}>
        {children}
      </select>
      {error && (
        <p id={errorId} className="field-error">
          <ErrorIcon />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
