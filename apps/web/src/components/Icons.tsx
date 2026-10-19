// Inline SVG icon set. No icon library: the CSP (`default-src 'self'`) forbids
// remote assets, and an npm icon pack would bloat a bundle whose whole point
// is to be small. All icons are 16×16, stroke-based, and inherit `currentColor`
// so they tone with the text around them.

type IconProps = { className?: string };

function Svg({ className, children }: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? "h-3.5 w-3.5"}
    >
      {children}
    </svg>
  );
}

export function PlusIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function ImageIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M13.5 10.5 10.5 7.5 4 13" />
    </Svg>
  );
}

export function RefreshIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v2.6h-2.6" />
    </Svg>
  );
}

export function ForkIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="6" cy="12.5" r="1.5" />
      <path d="M4 5v1.5c0 1 .8 1.8 1.8 1.8h4.4c1 0 1.8.8 1.8 1.8V11" />
      <path d="M6 11v-1.5" />
    </Svg>
  );
}

export function SendIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M8 13V3.5" />
      <path d="M3.5 8 8 3.5 12.5 8" />
    </Svg>
  );
}

export function StopIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FolderIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6c.5 0 .9.2 1.2.6l.8 1h4.4c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5v-7Z" />
    </Svg>
  );
}

export function FileIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M4 2h5l3 3v9H4V2Z" />
      <path d="M9 2v3h3" />
    </Svg>
  );
}

export function ChevronIcon({ open, ...p }: IconProps & { open: boolean }): React.ReactElement {
  return (
    <Svg {...p} >
      {open ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}
    </Svg>
  );
}

export function CheckIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M3 8.5 6.5 12 13 4" />
    </Svg>
  );
}

export function XIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M8 2.5 14 13H2L8 2.5Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.4" r=".2" fill="currentColor" />
    </Svg>
  );
}

export function SearchIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </Svg>
  );
}

export function TerminalIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 6.5 6.5 8l-2 1.5M8.5 10h3" />
    </Svg>
  );
}

export function GitIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 5.5v5M5.4 4.6 10.7 7.4" />
    </Svg>
  );
}

export function SaveIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M3 3h8.5L13 4.5V13H3V3Z" />
      <path d="M5.5 3v3h4V3M5.5 13v-4h5v4" />
    </Svg>
  );
}

export function ClockIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.8" />
    </Svg>
  );
}

export function SparkIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M8 2 9.3 6.7 14 8l-4.7 1.3L8 14l-1.3-4.7L2 8l4.7-1.3L8 2Z" />
    </Svg>
  );
}

export function SunIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </Svg>
  );
}

export function MoonIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8Z" />
    </Svg>
  );
}

export function BookIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M2.5 3.2c1.8-.6 3.6-.4 5.5.8v9c-1.9-1.2-3.7-1.4-5.5-.8v-9ZM13.5 3.2c-1.8-.6-3.6-.4-5.5.8v9c1.9-1.2 3.7-1.4 5.5-.8v-9Z" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M10.5 2.8 13.2 5.5 5.5 13.2H2.8v-2.7l7.7-7.7Z" />
      <path d="M9 4.3 11.7 7" />
    </Svg>
  );
}

export function FilePlusIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M4 2h5l3 3v9H4V2Z" />
      <path d="M8 7.5v4M6 9.5h4" />
    </Svg>
  );
}

export function GlobeIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.3 5.6 8S6.4 3.8 8 2.2Z" />
    </Svg>
  );
}

export function UsersIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="6" cy="5.5" r="2.2" />
      <path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" />
      <path d="M10.5 3.6a2 2 0 0 1 0 3.8M12 9.8c1.1.5 1.8 1.6 2 3.2" />
    </Svg>
  );
}

export function BrainIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.3 3.5A2.1 2.1 0 0 0 5 11.5a1.8 1.8 0 0 0 3 1V3.6A1.6 1.6 0 0 0 6 2.8Z" />
      <path d="M10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.3 3.5 2.1 2.1 0 0 1-2.3 3.2 1.8 1.8 0 0 1-3 1" />
    </Svg>
  );
}

export function ListIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
      <circle cx="3" cy="4" r=".6" fill="currentColor" />
      <circle cx="3" cy="8" r=".6" fill="currentColor" />
      <circle cx="3" cy="12" r=".6" fill="currentColor" />
    </Svg>
  );
}

export function QuestionIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4" />
      <circle cx="8" cy="11.4" r=".2" fill="currentColor" />
    </Svg>
  );
}

export function ShieldIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.5-5 6.6-2.9-1.1-5-3.5-5-6.6v-4l5-1.8Z" />
    </Svg>
  );
}

export function CopyIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.5" />
      <path d="M10.8 5.2V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5.3A1.5 1.5 0 0 0 4 10.8h1.2" />
    </Svg>
  );
}

export function SidebarIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
      <path d="M6 2.5v11" />
    </Svg>
  );
}

export function PanelRightIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
      <path d="M10 2.5v11" />
    </Svg>
  );
}

export function ArrowRightIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  );
}

export function ExternalIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      <path d="M12 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4.5A.5.5 0 0 1 3 4h3.5" />
    </Svg>
  );
}

export function ChatIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6.5l-3 2.5V11h0A1.5 1.5 0 0 1 2.5 9.5V4Z" />
    </Svg>
  );
}

export function RocketIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M9.5 2.2c2.3-.5 3.8-.4 4.3.1.5.5.6 2-.1 4.3L9 11.3 4.7 7l4.8-4.8Z" />
      <path d="M4.7 7 2.5 6.6 4.6 4.5h3M9 11.3l.4 2.2 2.1-2.1v-3" />
      <circle cx="10.6" cy="5.4" r="1" />
      <path d="M4 10.5c-1 .5-1.5 2-1.5 3 1 0 2.5-.5 3-1.5" />
    </Svg>
  );
}

export function ChartIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" />
    </Svg>
  );
}

export function WrenchIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M10 2.6a3.2 3.2 0 0 0-3.6 4.3L2.6 10.7a1.4 1.4 0 0 0 2 2l3.8-3.8A3.2 3.2 0 0 0 12.7 5l-1.9 1.9-1.6-.1-.1-1.6L11 3.3a3.2 3.2 0 0 0-1-.7Z" />
    </Svg>
  );
}

export function CodeIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />
    </Svg>
  );
}

export function HomeIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="M2.5 7.2 8 2.5l5.5 4.7V13a.5.5 0 0 1-.5.5H9.8V10H6.2v3.5H3a.5.5 0 0 1-.5-.5V7.2Z" />
    </Svg>
  );
}

export function LayersIcon(p: IconProps): React.ReactElement {
  return (
    <Svg {...p}>
      <path d="m8 2.2 6 3.2-6 3.2-6-3.2 6-3.2Z" />
      <path d="m2 8.5 6 3.2 6-3.2M2 11.3l6 3.2 6-3.2" />
    </Svg>
  );
}

/** The CodePilot mark: a gradient tile with a compass-like spark. */
export function LogoMark({ className, size = 28 }: { className?: string; size?: number }): React.ReactElement {
  const id = "cp-logo-grad";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7cff" />
          <stop offset="0.55" stopColor="#5b8dff" />
          <stop offset="1" stopColor="#3fc6ff" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id})`} />
      <path d="M16 7.5 18.4 13.6 24.5 16 18.4 18.4 16 24.5 13.6 18.4 7.5 16 13.6 13.6Z" fill="#fff" />
      <circle cx="16" cy="16" r="2" fill={`url(#${id})`} />
    </svg>
  );
}

export function DotIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className ?? "h-3.5 w-3.5"}>
      <circle cx="8" cy="8" r="4" fill="currentColor" />
    </svg>
  );
}

/** Spinning state mark for a tool that has not returned yet. */
export function SpinnerIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`animate-spin ${className ?? "h-3.5 w-3.5"}`}
    >
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="9 26"
        fill="none"
      />
    </svg>
  );
}
