import type { Project } from '@roadmap/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StatusMenu } from './StatusMenu.tsx';

afterEach(cleanup);

const launch = { id: 'p1', title: 'Launch site', status: 'not_started' } as Project;

describe('StatusMenu', () => {
  test('an editable item shows a button named with the title and status, and choosing a status calls onChange', () => {
    const onChange = vi.fn();
    render(<StatusMenu item={launch} editable onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Status of Launch site: Not started' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('done');
  });

  test('a read-only item shows the status as text with no button', () => {
    render(<StatusMenu item={launch} editable={false} onChange={vi.fn()} />);
    expect(screen.getByText('Not started')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
