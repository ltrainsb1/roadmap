/** A text field's value from a submitted form; empty when the field is missing. */
export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}
