import type { Annotation, FrozenSource } from './types';

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * One bullet per note, in the words an agent can search a codebase with.
 * Page-supplied values (text, selector, role) are untrusted, so they are
 * flattened to one line; a multi-line comment is indented so it cannot
 * start a fake bullet or header.
 *
 * `noteNumbers` carries the pin number the user sees for each note, so a
 * partial send quotes the same number instead of renumbering the subset.
 */
export function formatNotes(
  annotations: Annotation[],
  source?: FrozenSource,
  noteNumbers?: ReadonlyMap<string, number>,
): string {
  const body = annotations
    .map((a, i) => {
      const number = noteNumbers?.get(a.id) ?? i + 1;
      const comment = a.comment.trim().replace(/\r?\n/g, '\n  ') || '(no comment)';
      if (a.sourceRange) {
        const range = a.sourceRange;
        return `• #${number} Lines ${range.startLine}–${range.endLine}: ${comment}\n  ${range.text.replace(/\r?\n/g, '\n  ')}`;
      }
      const s = a.selection;
      if (s.kind !== 'element') return `• #${number} Box ${s.bounds.width}×${s.bounds.height}: ${comment}`;
      const tag = s.elementId.replace(/(-\d+){2}$/, '');
      const text = s.text ? oneLine(s.text).replace(/"/g, "'") : '';
      const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;
      const what = [
        oneLine(s.role || tag),
        shown ? `"${shown}"` : '',
        s.selector ? `(${oneLine(s.selector)})` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const component = s.component ? `\n  component: ${oneLine(s.component)}` : '';
      const styles = s.styles ? `\n  styles: ${oneLine(s.styles)}` : '';
      const also = (s.also ?? [])
        .map((e) => `\n  also: ${oneLine([e.selector, e.text ? `"${oneLine(e.text).replace(/"/g, "'").slice(0, 40)}"` : '', e.component ? `[${e.component}]` : ''].filter(Boolean).join(' '))}`)
        .join('');
      return `• #${number} ${what}: ${comment}${component}${styles}${also}`;
    })
    .join('\n');
  if (source?.kind !== 'terminal') return body;
  const title = source.title ? ` (${oneLine(source.title)})` : '';
  const header = `• Source: Kitty window ${source.windowId}${title}`;
  return body ? `${header}\n${body}` : header;
}
