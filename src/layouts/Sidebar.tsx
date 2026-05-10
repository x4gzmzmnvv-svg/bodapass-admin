import { useState, useEffect, useMemo, useRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ChartIcon,
  ClockIcon,
  HomeIcon,
  SettingsIcon,
  SiteIcon,
  TeamIcon,
  WageIcon,
} from '../components/Icon';
import { useAuth } from '../hooks/useAuth';
import './Sidebar.css';

/** 보다패스 로고 — 얼굴 스캔 SVG (배경 투명) */
function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="보다패스">
      <defs>
        <linearGradient id="bp-bg-grad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1E90FF" />
          <stop offset="1" stopColor="#0066E6" />
        </linearGradient>
        <linearGradient id="bp-person-grad" x1="32" y1="20" x2="32" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#A8D5FF" />
          <stop offset="1" stopColor="#6BB6FF" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bp-bg-grad)" />
      <path d="M14 24 V18 a4 4 0 0 1 4 -4 H24"
        stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M40 14 H46 a4 4 0 0 1 4 4 V24"
        stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M50 40 V46 a4 4 0 0 1 -4 4 H40"
        stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" fill="none" />
      <path d="M24 50 H18 a4 4 0 0 1 -4 -4 V40"
        stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" fill="none" />
      <circle cx="32" cy="28" r="6" fill="url(#bp-person-grad)" />
      <path d="M21 46 a11 9 0 0 1 22 0 v2 a2 2 0 0 1 -2 2 H23 a2 2 0 0 1 -2 -2 z" fill="url(#bp-person-grad)" />
    </svg>
  );
}

interface NavItem {
  to?: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
  children?: NavItem[];
  key?: string;
  color?: string;
}

const NAV_ITEMS_HQ: NavItem[] = [
  { to: '/', label: '대시보드', icon: <HomeIcon />, end: true, color: '#FF9500', key: 'dashboard' },
  {
    key: 'org', label: '운영관리', icon: <SiteIcon />, color: '#34C759',
    children: [
      { to: '/team', label: '인력관리', icon: <TeamIcon />, color: '#34C759' },
      { to: '/site', label: '현장관리', icon: <SiteIcon />, color: '#34C759' },
    ],
  },
  {
    key: 'workclose', label: '출역·노무마감', icon: <ClockIcon />, color: '#007AFF',
    children: [
      { to: '/auth-mgmt',     label: '인증관리',     icon: <ClockIcon />, color: '#007AFF' },
      { to: '/daily-confirm', label: '일일 출역확정', icon: <ClockIcon />, color: '#007AFF' },
      { to: '/gongsu-close',  label: '월 공수마감',   icon: <WageIcon />,  color: '#007AFF' },
      { to: '/wage-close',    label: '노무비 마감',   icon: <WageIcon />,  color: '#007AFF' },
    ],
  },
  {
    key: 'paydeclare', label: '지급·신고관리', icon: <WageIcon />, color: '#FF3B30',
    children: [
      { to: '/wage-pay',   label: '노무비 지급', icon: <WageIcon />, color: '#FF3B30' },
      { to: '/tax',        label: '세금관리',   icon: <WageIcon />, color: '#FF3B30' },
      { to: '/insurance',  label: '4대보험',    icon: <WageIcon />, color: '#FF3B30' },
      { to: '/severance',  label: '퇴직공제',   icon: <WageIcon />, color: '#FF3B30' },
    ],
  },
  {
    key: 'misc', label: '기타', icon: <SafetyIcon />, color: '#5856D6',
    children: [
      { to: '/safety',  label: '안전관리',     icon: <SafetyIcon />, color: '#5856D6' },
      { to: '/output',  label: '출력센터',     icon: <PrinterIcon />, color: '#5856D6' },
      { to: '/reports', label: '통계/리포트', icon: <ChartIcon />,   color: '#5856D6' },
    ],
  },
];

const NAV_ITEMS_SITE: NavItem[] = [
  { to: '/', label: '내 현장', icon: <HomeIcon />, end: true, color: '#FF9500', key: 'dashboard' },
  {
    key: 'org', label: '운영관리', icon: <SiteIcon />, color: '#34C759',
    children: [{ to: '/team', label: '인력관리', icon: <TeamIcon />, color: '#34C759' }],
  },
  {
    key: 'workclose', label: '출역·노무마감', icon: <ClockIcon />, color: '#007AFF',
    children: [
      { to: '/auth-mgmt',     label: '인증관리',     icon: <ClockIcon />, color: '#007AFF' },
      { to: '/daily-confirm', label: '일일 출역확정', icon: <ClockIcon />, color: '#007AFF' },
      { to: '/gongsu-close',  label: '월 공수마감',   icon: <WageIcon />,  color: '#007AFF' },
      { to: '/wage-close',    label: '노무비 마감',   icon: <WageIcon />,  color: '#007AFF' },
    ],
  },
  {
    key: 'paydeclare', label: '지급·신고관리', icon: <WageIcon />, color: '#FF3B30',
    children: [
      { to: '/wage-pay',   label: '노무비 지급', icon: <WageIcon />, color: '#FF3B30' },
      { to: '/insurance',  label: '4대보험',    icon: <WageIcon />, color: '#FF3B30' },
      { to: '/severance',  label: '퇴직공제',   icon: <WageIcon />, color: '#FF3B30' },
    ],
  },
  {
    key: 'misc', label: '기타', icon: <SafetyIcon />, color: '#5856D6',
    children: [
      { to: '/safety', label: '안전관리', icon: <SafetyIcon />, color: '#5856D6' },
      { to: '/output', label: '출력센터', icon: <PrinterIcon />, color: '#5856D6' },
    ],
  },
];

function PrinterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}

function SafetyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 18h18" />
      <path d="M5 18a7 7 0 0 1 14 0" />
      <path d="M11 4h2v4h-2z" />
      <path d="M12 12.5v3" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.18s ease' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

interface Props {
  collapsed?: boolean;
}

function itemKey(it: NavItem): string {
  return it.key ?? it.to ?? it.label;
}

export function Sidebar({ collapsed = false }: Props) {
  const { viewMode } = useAuth();
  const navItems = viewMode === 'SITE' ? NAV_ITEMS_SITE : NAV_ITEMS_HQ;
  const location = useLocation();
  const navigate = useNavigate();

  const activeGroupKey = useMemo(() => {
    for (const it of navItems) {
      if (it.children?.some((c) => c.to && location.pathname.startsWith(c.to))) return itemKey(it);
    }
    return null;
  }, [navItems, location.pathname]);

  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    navItems.forEach((it) => { if (it.children) init[itemKey(it)] = true; });
    return init;
  });

  useEffect(() => {
    if (activeGroupKey) {
      setOpenMap((prev) => prev[activeGroupKey] ? prev : { ...prev, [activeGroupKey]: true });
    }
  }, [activeGroupKey]);

  function toggleGroup(key: string) {
    setOpenMap((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Collapsed mode hover popover
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  function onEnterRail(k: string) {
    if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoverKey(k);
  }
  function onLeaveRail() {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoverKey(null), 120);
  }

  // ─── Collapsed (icon-only rail + popover) ───
  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <div className="sidebar__brand sidebar__brand--rail" title="보다패스">
          <BrandLogo size={28} />
        </div>
        <nav className="sidebar__rail">
          {navItems.map((it) => {
            const k = itemKey(it);
            const active = activeGroupKey === k || (it.to && location.pathname === it.to);
            return (
              <div key={k} className="sidebar__rail-slot" onMouseEnter={() => onEnterRail(k)} onMouseLeave={onLeaveRail}>
                {it.to && !it.children ? (
                  <NavLink to={it.to} end={it.end} className={({ isActive }) => 'sidebar__rail-btn' + (isActive ? ' sidebar__rail-btn--active' : '')} title={it.label}>
                    <span className="sidebar__item-icon">{it.icon}</span>
                  </NavLink>
                ) : (
                  <button type="button" className={'sidebar__rail-btn' + (active ? ' sidebar__rail-btn--active' : '')} onClick={() => it.children && it.children[0]?.to && navigate(it.children[0].to!)} title={it.label}>
                    <span className="sidebar__item-icon">{it.icon}</span>
                  </button>
                )}
                {hoverKey === k && (
                  <div className={'sidebar__popover' + (it.children ? '' : ' sidebar__popover--tip')}>
                    <div className="sidebar__popover-title">{it.label}</div>
                    {it.children && (
                      <ul className="sidebar__popover-list">
                        {it.children.map((c) => (
                          <li key={c.to}>
                            <NavLink to={c.to!} end={c.end} className={({ isActive }) => 'sidebar__popover-item' + (isActive ? ' is-active' : '')}>
                              <span className="sidebar__item-icon">{c.icon}</span>
                              <span>{c.label}</span>
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        {viewMode === 'HQ' && (
          <div className="sidebar__foot sidebar__foot--rail">
            <NavLink to="/settings" className={({ isActive }) => 'sidebar__rail-btn' + (isActive ? ' sidebar__rail-btn--active' : '')} title="설정">
              <span className="sidebar__item-icon"><SettingsIcon /></span>
            </NavLink>
          </div>
        )}
      </aside>
    );
  }

  // ─── Expanded (tree) ───
  return (
    <aside className="sidebar sidebar--tree">
      <div className="sidebar__brand">
        <BrandLogo size={28} />
        <span className="sidebar__brand-mark">보다패스</span>
        {viewMode === 'SITE' && <span className="sidebar__brand-mode">현장</span>}
      </div>
      <nav className="sidebar__nav">
        {navItems.map((it) => {
          const k = itemKey(it);
          if (it.children) {
            const open = openMap[k] ?? true;
            return (
              <div key={k} className="sidebar__group">
                <button type="button" className={'sidebar__item sidebar__item--group' + (activeGroupKey === k ? ' sidebar__item--group-active' : '')} onClick={() => toggleGroup(k)} aria-expanded={open}>
                  <span className="sidebar__item-icon">{it.icon}</span>
                  <span className="sidebar__item-label">{it.label}</span>
                  <span className="sidebar__chevron"><ChevronIcon open={open} /></span>
                </button>
                {open && (
                  <div className="sidebar__sub">
                    {it.children.map((c) => (
                      <NavLink key={c.to} to={c.to!} end={c.end} className={({ isActive }) => 'sidebar__item sidebar__item--sub' + (isActive ? ' sidebar__item--active' : '')}>
                        <span className="sidebar__item-icon sidebar__item-icon--sub">{c.icon}</span>
                        <span className="sidebar__item-label">{c.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <NavLink key={k} to={it.to!} end={it.end} className={({ isActive }) => 'sidebar__item' + (isActive ? ' sidebar__item--active' : '')}>
              <span className="sidebar__item-icon">{it.icon}</span>
              <span className="sidebar__item-label">{it.label}</span>
            </NavLink>
          );
        })}
      </nav>
      {viewMode === 'HQ' && (
        <div className="sidebar__foot">
          <NavLink to="/settings" className={({ isActive }) => 'sidebar__item' + (isActive ? ' sidebar__item--active' : '')}>
            <span className="sidebar__item-icon"><SettingsIcon /></span>
            <span className="sidebar__item-label">설정</span>
          </NavLink>
        </div>
      )}
    </aside>
  );
}