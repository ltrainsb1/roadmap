import type { Mention } from '@roadmap/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Markdown } from './Markdown.tsx';

afterEach(cleanup);

const ann: Mention = { userId: 'u1', name: 'Ann' };
const anna: Mention = { userId: 'u2', name: 'Anna' };
const odd: Mention = { userId: 'u3', name: 'J. (Jo) O_Neil*' };

function show(body: string, mentions: readonly Mention[] = []): HTMLElement {
  const { container } = render(<Markdown body={body} mentions={mentions} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('nothing rendered');
  expect(root.className).toBe('markdown');
  return root;
}

function mentionTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.mention'), (el) => el.textContent);
}

describe('Markdown', () => {
  test('FR-1.5: bold, emphasis, lists, quotes and code render as their elements', () => {
    const root = show(
      ['**bold** and *em* and `tick`', '', '- one', '- two', '', '> quoted', '', '```', 'block', '```'].join('\n'),
    );
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('em');
    expect(Array.from(root.querySelectorAll('ul > li'), (li) => li.textContent)).toEqual(['one', 'two']);
    expect(root.querySelector('blockquote')?.textContent.trim()).toBe('quoted');
    expect(root.querySelector('p > code')?.textContent).toBe('tick');
    expect(root.querySelector('pre > code')?.textContent).toBe('block\n');
  });

  test('FR-1.5: a heading renders as a bold paragraph, never as h1 to h6', () => {
    const root = show('# Title\n\n###### Small');
    expect(root.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(Array.from(root.querySelectorAll('p > strong'), (el) => el.textContent)).toEqual(['Title', 'Small']);
  });

  test('FR-1.5: a web link opens in a new tab without the opener or referrer', () => {
    const root = show('[site](https://example.com) and [mail](mailto:ann@example.com)');
    const links = root.querySelectorAll('a');
    expect(links).toHaveLength(2);
    const [site, mail] = links;
    expect(site?.textContent).toBe('site');
    expect(site?.getAttribute('href')).toBe('https://example.com');
    expect(site?.getAttribute('target')).toBe('_blank');
    expect(site?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(mail?.getAttribute('href')).toBe('mailto:ann@example.com');
  });

  test('FR-1.5: javascript:, data:, vbscript: and relative links keep their text but lose the href', () => {
    const root = show(
      '[a](javascript:alert(1)) [b](data:text/html,hi) [c](vbscript:x) [d](JavaScript:alert(1)) [e](/settings)',
    );
    const links = Array.from(root.querySelectorAll('a'));
    expect(links.map((a) => a.textContent)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const link of links) expect(link.hasAttribute('href')).toBe(false);
  });

  test('FR-1.5: raw HTML shows as text and creates no script or img element', () => {
    const root = show('<script>alert(1)</script>\n\nsee <img src=x onerror=alert(1)> here');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('FR-1.5: a code block takes keyboard focus, so a wide one can be scrolled without a mouse', () => {
    const root = show('```\nwide\n```');
    expect(root.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
  });

  test('FR-1.5: an image is not loaded; it shows as a link with its alt text', () => {
    const root = show('![chart](https://example.com/a.png)');
    expect(root.querySelector('img')).toBeNull();
    const link = root.querySelector('a');
    expect(link?.textContent).toBe('chart');
    expect(link?.getAttribute('href')).toBe('https://example.com/a.png');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('FR-1.5: recorded mentions are highlighted, longest name first', () => {
    const root = show('hi @Anna and @Ann', [ann, anna]);
    expect(mentionTexts(root)).toEqual(['@Anna', '@Ann']);
    expect(root.textContent).toBe('hi @Anna and @Ann');
  });

  test('FR-1.5: @Name with no recorded mention is not highlighted', () => {
    expect(mentionTexts(show('hi @Ann'))).toEqual([]);
    expect(mentionTexts(show('hi @Ann', [anna]))).toEqual([]);
  });

  test('FR-1.5: a mention inside bold text is highlighted inside the strong', () => {
    const root = show('**@Ann**', [ann]);
    expect(root.querySelector('strong > span.mention')?.textContent).toBe('@Ann');
  });

  test('FR-1.5: a mention inside inline code or a code block is not highlighted', () => {
    const root = show('`@Ann`\n\n```\n@Ann\n```', [ann]);
    expect(mentionTexts(root)).toEqual([]);
    expect(root.querySelector('p > code')?.textContent).toBe('@Ann');
    expect(root.querySelector('pre > code')?.textContent).toBe('@Ann\n');
  });

  test('FR-1.5: a name with ".", "(", "_" and "*" is highlighted whole', () => {
    const root = show('thanks @J. (Jo) O_Neil* for this', [odd]);
    expect(mentionTexts(root)).toEqual(['@J. (Jo) O_Neil*']);
    expect(root.textContent).toBe('thanks @J. (Jo) O_Neil* for this');
  });

  test('FR-1.5: an image inside a link shows as the link with its alt text, with no link inside a link', () => {
    const root = show('[![alt](https://example.com/a.png)](https://example.com) and [![ref][pic]](https://example.com/b)\n\n[pic]: https://example.com/p.png');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a a')).toBeNull();
    const links = Array.from(root.querySelectorAll('a'));
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['alt', 'https://example.com'],
      ['ref', 'https://example.com/b'],
    ]);
  });

  test('FR-1.5: an image outside a link still shows as a link with no link inside it', () => {
    const root = show('see ![chart](https://example.com/a.png) here');
    expect(root.querySelector('a a')).toBeNull();
    expect(root.querySelector('a')?.textContent).toBe('chart');
  });

  test.each([
    ['5,000 ">"', '>'.repeat(5000)],
    ['2,500 "> "', '> '.repeat(2500)],
    ['60 ">" then text', `${'>'.repeat(60)} hi`],
    ['1,666 "1. "', '1. '.repeat(1666)],
    ['1,250 "- > "', '- > '.repeat(1250)],
  ])('FR-1.5: a note nested past 50 levels (%s) shows as plain text', (_label, body) => {
    const root = show(body);
    expect(root.querySelector('blockquote, ul, ol')).toBeNull();
    const plain = root.querySelector('p.markdown-plain');
    expect(plain?.textContent).toBe(body);
    expect(root.children).toHaveLength(1);
  });

  test('FR-1.5: lists nested deeply through indentation show as plain text', () => {
    let body = '';
    for (let indent = 0; body.length < 4800; indent += 80) body += `${' '.repeat(indent)}${'- '.repeat(40)}a\n`;
    const root = show(body);
    expect(root.querySelector('ul')).toBeNull();
    expect(root.querySelector('p.markdown-plain')?.textContent).toBe(body);
  });

  test('FR-1.5: 50 levels of block quotes still render as nested block quotes', () => {
    const root = show(`${'>'.repeat(50)} hi @Ann`, [ann]);
    expect(root.querySelectorAll('blockquote')).toHaveLength(50);
    expect(root.querySelector('.markdown-plain')).toBeNull();
    expect(mentionTexts(root)).toEqual(['@Ann']);
  });

  // The budget guards against runaway parsing, not speed: this takes about
  // 1.2 s on a 2-vCPU CI runner with coverage on, and far less on a laptop.
  test('FR-1.5: 5,000 "*" and "_" characters render without runaway parsing', () => {
    const body = '*_'.repeat(2500);
    const started = performance.now();
    const root = show(body);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(root.textContent.length).toBeGreaterThan(0);
  });
});
