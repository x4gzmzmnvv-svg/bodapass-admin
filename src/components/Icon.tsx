import { SVGProps } from 'react';

/**
 * 사이드바·헤더·표 등에서 쓰이는 SVG 아이콘 모음.
 * 외부 라이브러리(lucide 등) 의존을 피하고 현재 색을 따라가도록 currentColor 사용.
 *
 * 24x24 grid 기준, stroke 1.75.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const HomeIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 11 12 4l9 7" />
    <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  </svg>
);

export const TeamIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <circle cx="17.5" cy="9.5" r="2.5" />
    <path d="M14.5 19c.3-2.4 2.4-4.3 4.9-4.3 1.4 0 2.6.6 3.5 1.5" />
  </svg>
);

export const ChartIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M3 20h18" />
  </svg>
);

export const ClockIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const SiteIcon = ({ size = 22, ...rest }: IconProps) => (
  // 건물(현장) 아이콘
  <svg {...base(size)} {...rest}>
    <path d="M3 21h18" />
    <path d="M5 21V8l7-5 7 5v13" />
    <path d="M9 21v-6h6v6" />
    <path d="M9 11h0M12 11h0M15 11h0" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

export const WageIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9h5a2 2 0 1 1 0 4H9" />
    <path d="M9 13h5a2 2 0 1 1 0 4H9" />
    <path d="M11 7v10" />
  </svg>
);

export const NoticeIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M6 8a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v6l2 3H4l2-3V8z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </svg>
);

export const SettingsIcon = ({ size = 22, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12c0 .5 0 1-.1 1.5l2.1 1.6-2 3.4-2.5-1a7 7 0 0 1-2.6 1.5L13.5 22h-3l-.4-2.9a7 7 0 0 1-2.6-1.5l-2.5 1-2-3.4L5 13.5C5 13 5 12.5 5 12s0-1 .1-1.5L3 8.9l2-3.4 2.5 1A7 7 0 0 1 10.1 5L10.5 2h3l.4 3a7 7 0 0 1 2.6 1.5l2.5-1 2 3.4-2.1 1.6c.1.5.1 1 .1 1.5z" />
  </svg>
);

export const SearchIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const BellIcon = ({ size = 20, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M6 8a6 6 0 1 1 12 0v5l1.5 2H4.5L6 13z" />
    <path d="M9 19a3 3 0 0 0 6 0" />
  </svg>
);

export const ContactIcon = ({ size = 20, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="11" r="2.5" />
    <path d="M8 17a4 4 0 0 1 8 0" />
    <path d="M3 8h2M3 12h2M3 16h2" />
  </svg>
);

export const ChevronRightIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const ChevronDownIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const SunIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);

export const PlusIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const LogoutIcon = ({ size = 18, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M10 17 5 12l5-5" />
    <path d="M5 12h12" />
  </svg>
);
