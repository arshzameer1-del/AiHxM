/**
 * Small coloured pictograms for the structure tree, drawn after the SAP organization-structure icons:
 * a pale box for an organizational unit, a seated figure for a position (orange with a cap for the chief
 * position, dark red for the others) and two overlapping people for the person holding it.
 */

type IconProps = { title: string; size?: number };

function Svg({ title, size = 20, children }: IconProps & { children: React.ReactNode }) {
  return (
    <span title={title} aria-hidden="true" className="inline-flex shrink-0">
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
        {children}
      </svg>
    </span>
  );
}

export function UnitIcon({ title, size }: IconProps) {
  return (
    <Svg title={title} size={size}>
      <defs>
        <linearGradient id="org-unit-box" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dfe4ea" />
        </linearGradient>
      </defs>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" fill="url(#org-unit-box)" stroke="#8d97a5" />
      <rect x="3.5" y="4.5" width="11" height="1.6" rx="0.8" fill="#ffffff" opacity="0.9" />
    </Svg>
  );
}

export function PositionIcon({ title, size, chief }: IconProps & { chief: boolean }) {
  const body = chief ? "#f08a1c" : "#8c2b24";
  const bodyEdge = chief ? "#b4600a" : "#5c1612";
  return (
    <Svg title={title} size={size}>
      {/* shoulders */}
      <path d="M3.2 16.2c0-3.3 2.4-5.2 5.8-5.2s5.8 1.9 5.8 5.2z" fill={body} stroke={bodyEdge} strokeWidth="0.8" strokeLinejoin="round" />
      {/* collar */}
      <path d="M7.6 11.2 9 13.2l1.4-2" stroke={bodyEdge} strokeWidth="0.8" strokeLinejoin="round" />
      {/* head */}
      <circle cx="9" cy="6.9" r="3" fill="#f3cfa8" stroke="#a9744a" strokeWidth="0.8" />
      {chief ? (
        /* cap marks the chief position */
        <path d="M5.7 6.4C5.8 3.9 7.2 2.6 9 2.6s3.2 1.3 3.3 3.8z" fill="#2b2b2b" />
      ) : (
        <path d="M6 6.3C6.2 4.5 7.4 3.7 9 3.7s2.8.8 3 2.6c-1.5-1-4.5-1-6 0z" fill="#5a3a26" />
      )}
    </Svg>
  );
}

export function HolderIcon({ title, size }: IconProps) {
  return (
    <Svg title={title} size={size}>
      {/* person behind */}
      <circle cx="12.2" cy="6" r="2.3" fill="#f3cfa8" stroke="#a9744a" strokeWidth="0.7" />
      <path d="M8.4 14.6c0-2.6 1.7-4.1 3.8-4.1s3.8 1.5 3.8 4.1z" fill="#4a9d5b" stroke="#2f6e3c" strokeWidth="0.7" strokeLinejoin="round" />
      {/* person in front */}
      <circle cx="6.6" cy="7.2" r="2.5" fill="#f3cfa8" stroke="#a9744a" strokeWidth="0.7" />
      <path d="M2.2 16c0-3 2-4.6 4.4-4.6S11 13 11 16z" fill="#2f78b7" stroke="#1d4f7e" strokeWidth="0.7" strokeLinejoin="round" />
    </Svg>
  );
}
