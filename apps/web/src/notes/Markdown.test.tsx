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

  test('FR-1.5: 5,000 "*" and "_" characters render in under a second', () => {
    const body = '*_'.repeat(2500);
    const started = performance.now();
    const root = show(body);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(root.textContent.length).toBeGreaterThan(0);
  });
});
