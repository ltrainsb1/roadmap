import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Markdown } from './Markdown.tsx';

// A renderer that fails on one body, to show the boundary catches whatever the real one might throw.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    if (children === 'breaks') throw new RangeError('Maximum call stack size exceeded');
    return <p className="rendered">{children}</p>;
  },
}));

afterEach(cleanup);

describe('Markdown fallback', () => {
  test('FR-1.5: if rendering throws, the note shows as plain text, and a new body renders again', () => {
    const onCaughtError = vi.fn();
    const { container, rerender } = render(<Markdown body="breaks" mentions={[]} />, { onCaughtError });
    expect(onCaughtError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.markdown > p.markdown-plain')?.textContent).toBe('breaks');
    expect(container.querySelector('.rendered')).toBeNull();

    rerender(<Markdown body="fine" mentions={[]} />);
    expect(container.querySelector('.markdown > p.rendered')?.textContent).toBe('fine');
    expect(container.querySelector('.markdown-plain')).toBeNull();
    expect(onCaughtError).toHaveBeenCalledTimes(1);
  });
});
