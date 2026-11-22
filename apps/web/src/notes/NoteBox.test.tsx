import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MemberName } from '../projects/PanelLists.tsx';
import { NoteBox } from './NoteBox.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MEMBERS: MemberName[] = [
  { userId: 'u-cara', name: 'Cara Diaz' },
  { userId: 'u-ann', name: 'Ann Lee' },
  { userId: 'u-zed', name: 'Zed Ox' },
  { userId: 'u-bo', name: 'Bo Park' },
];

function setup(opts: { members?: MemberName[]; initial?: string; initialMentions?: { userId: string; name: string }[] } = {}) {
  const onSubmit = vi.fn<(body: string, mentionIds: string[]) => Promise<boolean>>(() => Promise.resolve(false));
  const keys: Array<{ key: string; prevented: boolean }> = [];
  render(
    <div onKeyDown={(e) => keys.push({ key: e.key, prevented: e.defaultPrevented })}>
      <NoteBox
        label="Add a note"
        submitLabel="Add note"
        initial={opts.initial ?? ''}
        initialMentions={opts.initialMentions}
        members={opts.members ?? MEMBERS}
        busy={false}
        error={undefined}
        onSubmit={onSubmit}
      />
    </div>,
  );
  const box = screen.getByLabelText<HTMLTextAreaElement>('Add a note');
  box.focus();
  return { box, onSubmit, keys };
}

/** Sets the text with the caret at its end, as typing does. */
const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });
const list = () => screen.queryByRole('listbox', { name: 'People' });
const options = () => within(list()!).queryAllByRole('option');
const active = (box: HTMLElement) => box.getAttribute('aria-activedescendant');
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

describe('NoteBox @ list', () => {
  test('FR-1.5: typing "@a" opens a listbox named "People" with the matches and the first one active', () => {
    const { box } = setup();
    expect(box.getAttribute('role')).toBeNull();
    expect(box.hasAttribute('aria-expanded')).toBe(false);
    type(box, '@a');
    const people = list();
    expect(people).toBeTruthy();
    expect(options().map((o) => o.textContent)).toEqual(['Ann Lee', 'Bo Park', 'Cara Diaz']);
    expect(screen.getByRole('combobox', { name: 'Add a note' })).toBe(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(box.getAttribute('aria-controls')).toBe(people!.id);
    expect(active(box)).toBe(options()[0]!.id);
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    // Rendered next to the text box, placed in window coordinates.
    expect(box.parentElement!.contains(people)).toBe(true);
    expect(people!.closest<HTMLElement>('.mention-picker')!.style.position).toBe('fixed');
  });

  test('FR-1.5: Down, Down, Up moves aria-activedescendant', () => {
    const { box } = setup();
    type(box, '@a');
    const ids = options().map((o) => o.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(active(box)).toBe(ids[1]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(active(box)).toBe(ids[2]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(active(box)).toBe(ids[0]); // wraps
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active(box)).toBe(ids[2]);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active(box)).toBe(ids[0]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(active(box)).toBe(ids[1]);
  });

  test('FR-1.5: Enter inserts the name and does not submit', () => {
    const { box, onSubmit } = setup();
    type(box, 'hi @a');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(false);
    expect(box.value).toBe('hi @Bo Park ');
    expect(box.selectionStart).toBe(12);
    expect(list()).toBeNull();
    expect(box.getAttribute('role')).toBeNull();
    expect(box.hasAttribute('aria-activedescendant')).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('FR-1.5: Tab picks too, and leaves focus in the box', () => {
    const { box } = setup();
    type(box, '@ca');
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);
    expect(box.value).toBe('@Cara Diaz ');
    expect(document.activeElement).toBe(box);
  });

  test('FR-1.5: Escape closes the list and leaves the text; the panel does not see it', () => {
    const { box, keys } = setup();
    type(box, 'hi @an');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(list()).toBeNull();
    expect(box.value).toBe('hi @an');
    expect(keys).toEqual([{ key: 'Escape', prevented: true }]);
    // Typing on in the same mention keeps it closed; a new @ opens it again.
    type(box, 'hi @ann');
    expect(list()).toBeNull();
    type(box, 'hi @ann @b');
    expect(options().map((o) => o.textContent)).toEqual(['Bo Park']);
    // With the list closed, Escape is the panel's.
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(keys.at(-1)).toEqual({ key: 'Escape', prevented: false });
  });

  test('FR-1.5: "No one matches." shows for "@zzz" and Enter then adds a new line as usual', () => {
    const { box, onSubmit } = setup();
    type(box, '@zzz');
    expect(screen.getByText('No one matches.')).toBeTruthy();
    expect(options()).toEqual([]);
    expect(box.hasAttribute('aria-activedescendant')).toBe(false);
    expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'ArrowDown' })).toBe(true);
    expect(box.value).toBe('@zzz');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('FR-1.5: with the list closed, Enter, Tab and the arrows are left alone', () => {
    const { box } = setup();
    type(box, 'plain');
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp']) expect(fireEvent.keyDown(box, { key })).toBe(true);
  });

  test('FR-1.5: keys pressed while composing text (IME) are left alone', () => {
    const { box } = setup();
    type(box, '@a');
    const before = active(box);
    expect(fireEvent.keyDown(box, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Escape', isComposing: true })).toBe(true);
    // Safari reports the key that ends composing as keyCode 229.
    expect(fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(box.value).toBe('@a');
    expect(active(box)).toBe(before);
    expect(list()).toBeTruthy();
  });

  test('FR-1.5: clicking an option inserts it and the textarea keeps focus', () => {
    const { box } = setup();
    type(box, 'see @z');
    const option = screen.getByRole('option', { name: 'Zed Ox' });
    // Pressing the option does not take focus from the text box.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
    expect(box.value).toBe('see @Zed Ox ');
    expect(document.activeElement).toBe(box);
    expect(list()).toBeNull();
  });

  test('FR-1.5: submitting "hello @Ann Lee" calls onSubmit with Ann\'s id', () => {
    const { box, onSubmit } = setup();
    type(box, 'hello @Ann Lee');
    submit();
    expect(onSubmit).toHaveBeenCalledWith('hello @Ann Lee', ['u-ann']);
  });

  test('FR-1.5: a picked name is sent; deleting part of it before submitting sends no id', () => {
    const { box, onSubmit } = setup();
    type(box, 'hello @an');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('hello @Ann Lee ');
    type(box, 'hello @Ann Le');
    submit();
    expect(onSubmit).toHaveBeenLastCalledWith('hello @Ann Le', []);
  });

  test('FR-1.5: each person mentioned is sent once, in order', () => {
    const { box, onSubmit } = setup();
    type(box, '@Zed Ox and (@Ann Lee) and @Zed Ox again, not mail@Bo Park');
    submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.any(String), ['u-zed', 'u-ann']);
  });

  describe('two members with the same name', () => {
    const twins: MemberName[] = [
      { userId: 'u-ann1', name: 'Ann Lee', email: 'ann.one@example.com' },
      { userId: 'u-ann2', name: 'Ann Lee', email: 'ann.two@example.com' },
      { userId: 'u-bo', name: 'Bo Park', email: 'bo@example.com' },
    ];

    test('FR-1.5: both are listed with their email after the name, and the one picked is sent', () => {
      const { box, onSubmit } = setup({ members: twins });
      type(box, '@ann');
      expect(options().map((o) => o.textContent)).toEqual(['Ann Lee ann.one@example.com', 'Ann Lee ann.two@example.com']);
      // The only Bo shows no email.
      type(box, '@b');
      expect(options().map((o) => o.textContent)).toEqual(['Bo Park']);
      type(box, '@ann');
      fireEvent.keyDown(box, { key: 'ArrowDown' });
      fireEvent.keyDown(box, { key: 'Enter' });
      // The first one picked is the one recorded, even when the other is picked later.
      type(box, `${box.value}and @ann`);
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(box.value).toBe('@Ann Lee and @Ann Lee ');
      submit();
      expect(onSubmit).toHaveBeenLastCalledWith('@Ann Lee and @Ann Lee ', ['u-ann2']);
    });

    test('FR-1.5: a hand-typed name goes to the first member with it, and a pick is forgotten once its name leaves the text', () => {
      const { box, onSubmit } = setup({ members: twins });
      type(box, '@Ann Lee');
      submit();
      expect(onSubmit).toHaveBeenLastCalledWith('@Ann Lee', ['u-ann1']);
      type(box, '@ann');
      fireEvent.keyDown(box, { key: 'ArrowDown' });
      fireEvent.keyDown(box, { key: 'Enter' });
      type(box, 'gone');
      type(box, '@Ann Lee');
      submit();
      expect(onSubmit).toHaveBeenLastCalledWith('@Ann Lee', ['u-ann1']);
    });

    test('FR-1.5: editing a note starts from the people it mentions; a removed member is not in the list', () => {
      const { box, onSubmit } = setup({
        members: twins,
        initial: 'ask @Ann Lee and @Old Name',
        initialMentions: [
          { userId: 'u-ann2', name: 'Ann Lee' },
          { userId: 'u-gone', name: 'Old Name' },
        ],
      });
      type(box, 'ask @Ann Lee and @Old Name today');
      submit();
      expect(onSubmit).toHaveBeenLastCalledWith('ask @Ann Lee and @Old Name today', ['u-ann2']);
      type(box, '@Ol');
      expect(screen.getByText('No one matches.')).toBeTruthy();
    });
  });

  test('FR-1.5: a list closed with Escape opens again for a new @ in the same place', async () => {
    const { box, onSubmit } = setup();
    onSubmit.mockResolvedValue(true);
    type(box, '@');
    fireEvent.keyDown(box, { key: 'Escape' });
    type(box, '@x');
    expect(list()).toBeNull();
    submit();
    await vi.waitFor(() => expect(box.value).toBe(''));
    type(box, '@');
    expect(list()).toBeTruthy();
    // And after deleting the @ by hand.
    fireEvent.keyDown(box, { key: 'Escape' });
    type(box, '');
    type(box, '@');
    expect(list()).toBeTruthy();
  });

  test('FR-1.5: the list closes on blur and when the caret leaves the @', () => {
    const { box } = setup();
    type(box, 'hi @a');
    fireEvent.blur(box);
    expect(list()).toBeNull();
    fireEvent.focus(box);
    type(box, 'hi @an');
    expect(list()).toBeNull();
    type(box, 'hi @an @b');
    expect(list()).toBeTruthy();
    // Moving the caret with the keys or the mouse.
    box.setSelectionRange(1, 1);
    fireEvent.keyUp(box, { key: 'ArrowLeft' });
    expect(list()).toBeNull();
    box.setSelectionRange(9, 9);
    fireEvent.mouseUp(box);
    expect(list()).toBeTruthy();
  });

  test('FR-1.5: the list opens under the box, or over it when there is no room below, and stays inside the window', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(140);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    const { box } = setup();
    const rect = vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 260, 80));
    type(box, '@a');
    const picker = () => document.querySelector<HTMLElement>('.mention-picker')!;
    expect([picker().style.top, picker().style.left]).toEqual(['184px', `${375 - 8 - 300}px`]);
    fireEvent.keyDown(box, { key: 'Escape' });

    rect.mockReturnValue(new DOMRect(16, window.innerHeight - 90, 260, 80));
    type(box, '@a @b');
    expect(picker().style.top).toBe(`${window.innerHeight - 90 - 4 - 140}px`);
    expect(picker().style.left).toBe('16px');
    delete (document.documentElement as { clientWidth?: number }).clientWidth;
  });

  test('FR-1.5: a scroll that moves the box closes the list; one that does not leaves it', () => {
    const { box } = setup();
    let top = 100;
    vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => new DOMRect(16, top, 260, 80));
    type(box, '@a');
    fireEvent.scroll(window);
    expect(list()).toBeTruthy();
    top = 40;
    fireEvent.scroll(window);
    expect(list()).toBeNull();
    expect(box.value).toBe('@a');
  });

  test('FR-1.5: the active option is scrolled into view in a capped list', () => {
    const { box } = setup();
    type(box, '@a');
    const picker = document.querySelector<HTMLElement>('.mention-picker')!;
    const last = options()[2]!;
    vi.spyOn(picker, 'clientHeight', 'get').mockReturnValue(44);
    vi.spyOn(last, 'offsetTop', 'get').mockReturnValue(88);
    vi.spyOn(last, 'offsetHeight', 'get').mockReturnValue(44);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(picker.scrollTop).toBe(88);
  });
});
