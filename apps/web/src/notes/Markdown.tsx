import { type Mention, mentionRanges } from '@roadmap/shared';
import { Component, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

/** The parts of an mdast node the note plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: Array<{ type: 'text'; value: string }>;
  };
}

/** A line that starts with more than this many block quote or list markers shows the note as plain text. */
const MAX_LINE_NESTING = 50;
/**
 * A parsed note deeper than this shows as plain text. Rendering recurses once per level, and a few
 * thousand levels (possible within 5,000 characters) overflow the stack.
 */
const MAX_TREE_DEPTH = 200;

/** True when a line starts with more than MAX_LINE_NESTING `>` or list markers. Cheap: no parsing. */
function nestsTooDeep(body: string): boolean {
  for (const line of body.split(/\r\n?|\n/)) {
    let markers = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') {
        i += 1;
        continue;
      }
      const next =
        ch === '>' || ch === '-' || ch === '+' || ch === '*'
          ? i + 1
          : i + (/^\d{1,9}[.)]/.exec(line.slice(i, i + 10))?.[0].length ?? 0);
      // A list marker counts only when white space or the end of the line follows it.
      const after = line[next];
      if (next === i || (ch !== '>' && after !== undefined && after !== ' ' && after !== '\t')) break;
      markers += 1;
      if (markers > MAX_LINE_NESTING) return true;
      i = next;
    }
  }
  return false;
}

/** The depth of the tree, measured without recursion. */
function treeDepth(tree: MdNode): number {
  let deepest = 0;
  const pending: Array<[MdNode, number]> = [[tree, 0]];
  for (let item = pending.pop(); item; item = pending.pop()) {
    const [node, depth] = item;
    deepest = Math.max(deepest, depth);
    for (const child of node.children ?? []) pending.push([child, depth + 1]);
  }
  return deepest;
}

/**
 * A remark plugin for the note rules that need the parsed tree: a tree too deep to render becomes the
 * plain text; an image inside a link becomes its alt text, so a link never holds a link; recorded
 * mentions become `<span class="mention">`.
 */
function remarkNote({ body, mentions }: { body: string; mentions: readonly Mention[] }) {
  return (tree: MdNode): undefined => {
    if (treeDepth(tree) > MAX_TREE_DEPTH) {
      tree.children = [
        {
          type: 'paragraph',
          // hChildren is used as is; an mdast text node would have its line ends trimmed.
          data: { hProperties: { className: ['markdown-plain'] }, hChildren: [{ type: 'text', value: body }] },
          children: [],
        },
      ];
      return;
    }
    rewrite(tree, mentions, false);
  };
}

/**
 * Recursion is safe here: the tree is at most MAX_TREE_DEPTH deep. Code (`code`, `inlineCode`) holds
 * its text in `value`, not in text children, so it is never highlighted.
 */
function rewrite(node: MdNode, mentions: readonly Mention[], inLink: boolean): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (inLink && (child.type === 'image' || child.type === 'imageReference')) {
      next.push({ type: 'text', value: child.alt ?? '' });
      continue;
    }
    if (child.type !== 'text' || child.value === undefined) {
      rewrite(child, mentions, inLink || child.type === 'link' || child.type === 'linkReference');
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

function Plain({ body }: { body: string }) {
  return <p className="markdown-plain">{body}</p>;
}

interface PlainOnErrorProps {
  body: string;
  children: ReactNode;
}

/** If rendering throws, shows the plain text, so no note can take the panel down. Resets when the body changes. */
class PlainOnError extends Component<PlainOnErrorProps, { body: string; failed: boolean }> {
  override state = { body: this.props.body, failed: false };

  static getDerivedStateFromProps(props: PlainOnErrorProps, state: { body: string }) {
    return props.body === state.body ? null : { body: props.body, failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <Plain body={this.props.body} /> : this.props.children;
  }
}

/** A note's text as CommonMark, without raw HTML, with recorded mentions highlighted. */
export function Markdown({ body, mentions }: { body: string; mentions: readonly Mention[] }) {
  return (
    <div className="markdown">
      <PlainOnError body={body}>
        {nestsTooDeep(body) ? (
          <Plain body={body} />
        ) : (
          <ReactMarkdown
            components={components}
            remarkPlugins={[[remarkNote, { body, mentions }]]}
            urlTransform={keepSafeUrl}
          >
            {body}
          </ReactMarkdown>
        )}
      </PlainOnError>
    </div>
  );
}
