import { useEffect, type RefObject } from 'react';

/**
 * After a failed submit, moves focus to the first invalid field, or to the form alert when no field
 * is at fault. `signal` changes on every submit, so a repeated error focuses again.
 */
export function useFocusFirstError(form: RefObject<HTMLElement | null>, signal: unknown): void {
  useEffect(() => {
    if (!signal || !form.current) return;
    const target =
      form.current.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.current.parentElement?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
  }, [form, signal]);
}

/** What a form shows after a failed submit: one message above it, and one per field under the field. */
export interface FormErrors {
  form?: string;
  fields: Record<string, string>;
}
