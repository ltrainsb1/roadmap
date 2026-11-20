import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Field } from './Field.tsx';

afterEach(cleanup);

describe('Field', () => {
  test('ties the label, hint and error to the input', () => {
    render(<Field id="pw" label="New password" hint="At least 12 characters." error="Use at least 12 characters." />);
    const input = screen.getByLabelText('New password');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['At least 12 characters.', 'Use at least 12 characters.']);
  });

  test('has no error attributes when there is no error', () => {
    render(<Field id="email" label="Email" />);
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});
