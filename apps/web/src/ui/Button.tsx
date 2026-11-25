import type { ButtonHTMLAttributes, Ref } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the one main action of a screen; `link` looks like a text link but acts like a button. */
  variant?: 'primary' | 'secondary' | 'danger' | 'link';
  ref?: Ref<HTMLButtonElement>;
}

/** Buttons are never disabled: a missing step is explained by an error when the button is pressed. */
export function Button({ variant = 'secondary', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn-${variant}${className ? ` ${className}` : ''}`} {...rest} />;
}
