import type { Ref, SelectHTMLAttributes } from 'react';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: string;
  ref?: Ref<HTMLSelectElement>;
}

/** A visible label above a native select. */
export function SelectField({ id, label, children, ref, ...select }: SelectFieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} ref={ref} {...select}>
        {children}
      </select>
    </div>
  );
}
