import type { JSX } from 'solid-js';

// Lucide-style outline icons (ISC licence): 24px grid, rounded 1.75px strokes.
const paths = {
  back: 'm12 19-7-7 7-7M19 12H5',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  clear: 'M18 6 6 18M6 6l12 12',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  minus: 'M5 12h14',
  play: 'M6 3l14 9-14 9V3z',
  plus: 'M5 12h14M12 5v14',
  search: 'm21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
} as const;

export function Icon(props: { name: keyof typeof paths; class?: string }): JSX.Element {
  return (
    <svg
      class={props.class ?? 'w-4 h-4'}
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={paths[props.name]} />
    </svg>
  );
}
