import { type Mention, mentionRanges } from '@roadmap/shared';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

/** The parts of an mdast node the mention plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/**
 * A remark plugin that splits text nodes at recorded mentions, turning each `@Name` into
 * `<span class="mention">`. Code (`code`, `inlineCode`) holds its text in `value`, not in text
 * children, so it is never visited.
 */
function remarkMentions(mentions: readonly Mention[]) {
  return (tree: MdNode): undefined => {
    if (mentions.length > 0) splitChildren(tree, mentions);
  };
}

function splitChildren(node: MdNode, mentions: readonly Mention[]): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'text' || child.value === undefined) {
      splitChildren(child, mentions);
      next.push(child);
      continue;
    }
    const text = child.value;
    let at = 0;
    for (const { start, end } of mentionRanges(text, mentions)) {
      if (start > at) next.push({ type: 'text', value: text.slice(at, start) });
      next.push({
        type: 'text',
        value: text.slice(start, end),
        data: { hName: 'span', hProperties: { className: ['mention'] } },
      });
      at = end;
    }
    if (at === 0) next.push(child);
    else if (at < text.length) next.push({ type: 'text', value: text.slice(at) });
  }
  node.children = next;
}

const SAFE_URL = /^(?:https?|mailto):/i;

/** Keeps only http, https and mailto URLs; anything else loses the attribute. */
function keepSafeUrl(url: string): string | undefined {
  return SAFE_URL.test(url) ? url : undefined;
}

function NewTabLink({ href, children }: { href?: string | undefined; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function BoldParagraph({ children }: { children?: ReactNode }) {
  return (
    <p>
      <strong>{children}</strong>
    </p>
  );
}

const components: Components = {
  a: ({ href, children }) => <NewTabLink href={href}>{children}</NewTabLink>,
  // Images are never loaded: an image shows as a link to it, with its alt text.
  img: ({ src, alt }) => <NewTabLink href={typeof src === 'string' ? src : undefined}>{alt}</NewTabLink>,
  h1: BoldParagraph,
  h2: BoldParagraph,
  h3: BoldParagraph,
  h4: BoldParagraph,
  h5: BoldParagraph,
  h6: BoldParagraph,
};

/** A note's text as CommonMark, without raw HTML, with recorded mentions highlighted. */
export function Markdown({ body, mentions }: { body: string; mentions: readonly Mention[] }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={components}
        remarkPlugins={[[remarkMentions, mentions]]}
        urlTransform={keepSafeUrl}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
