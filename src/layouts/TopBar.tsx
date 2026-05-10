import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BellIcon,
  ContactIcon,
  LogoutIcon,
  SiteIcon,
} from '../components/Icon';
import { useAuth } from '../hooks/useAuth';
import { useWeather, type WeatherKind } from '../hooks/useWeather';
import { getDispatchLogs, type DispatchLog } from '../utils/messageTemplates';
import './TopBar.css';

interface BoardPostLite {
  id: string;
  siteId: string;
  category: '공지' | '안전' | '일정' | '자재';
  title: string;
  author: string;
  date: string;
}
const BOARD_KEY = 'ilgampack_admin:board';

function loadAllBoardPosts(): BoardPostLite[] {
  try {
    const raw = localStorage.getItem(BOARD_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as BoardPostLite[];
    return all
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * 상단 헤더 — 와이어프레임 006/007.png 기준
 *  - 좌측: "안녕하세요. 아코마님 · 2024.12.5(목) · 28°c ☀"
 *  - 우측: 검색, 알림, 연락처 아이콘, 프로필 드롭다운
 */
export function TopBar() {
  const { user, logout, viewMode } = useAuth();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [posts, setPosts] = useState<BoardPostLite[]>([]);
  const [logs, setLogs] = useState<DispatchLog[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const weather = useWeather();

  // 알림 popover 열릴 때 데이터 로드
  useEffect(() => {
    if (!notifOpen) return;
    setPosts(loadAllBoardPosts());
    setLogs(getDispatchLogs().slice(0, 5));
  }, [notifOpen]);

  // 알림 popover — 외부 클릭 / Esc 닫기
  useEffect(() => {
    if (!notifOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotifOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [notifOpen]);

  // 1분마다 시계 업데이트 (날짜 변경 대응)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header
      className="topbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 60,
        padding: '0 28px',
        gap: 24,
        background: '#FAFAFA',
        borderBottom: 0,
        position: 'sticky',
        top: 0,
        zIndex: 5,
      }}
    >
      <div className="topbar__greet">
        <p className="topbar__hello">
          안녕하세요. <strong>{user?.name ?? '관리자'}</strong>님
        </p>
        <div className="topbar__meta">
          <span>{formatKoreanDate(now)}</span>
          <span className="topbar__dot" aria-hidden />
          <span
            className="topbar__weather"
            title={
              weather.loading
                ? '날씨 정보를 불러오는 중...'
                : weather.error
                  ? '날씨 API 호출 실패: ' + weather.error
                  : weather.label +
                    ' · ' +
                    new Date(weather.fetchedAt).toLocaleTimeString('ko-KR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }) +
                    ' 갱신'
            }
          >
            <span className="topbar__weather-emoji" aria-hidden>
              {weather.emoji}
            </span>
            {weather.loading ? '…' : `${weather.temperatureC}°C`}
          </span>
          {!weather.loading && weatherRiskHint(weather.kind, weather.temperatureC) && (
            <button
              type="button"
              className="topbar__weather-alert"
              title="현장에 안전공지를 발송합니다."
              onClick={() => {
                const hint = weatherRiskHint(weather.kind, weather.temperatureC);
                if (!hint) return;
                if (window.confirm(`현재 ${weather.label} (${weather.temperatureC}°C). ${hint} 안내문자를 보내겠습니까?`)) {
                  // 안전관리 페이지로 이동 — 「+ 새 발송」을 자동으로 띄우는 query 사용
                  navigate('/safety?compose=weather');
                }
              }}
            >
              <span className="topbar__weather-alert-dot" aria-hidden />
              {weatherRiskHint(weather.kind, weather.temperatureC)}
            </button>
          )}
        </div>
      </div>

      <div className="topbar__actions">
        {/* 페이지별 액션 버튼이 React Portal로 여기에 들어옴 */}
        <div id="topbar-page-actions" className="topbar__page-actions" />

        {/* 검색창 제거됨 — 사이드바 메뉴로 충분 */}
        {/* 연락처 아이콘 제거됨 — 사용 빈도 낮음 */}

        <div className="topbar__notif" ref={notifRef}>
          <button
            className="topbar__icon-btn"
            aria-label="알림"
            aria-expanded={notifOpen}
            onClick={() => setNotifOpen((v) => !v)}
            title="현장 게시판 + 알림톡 발송 이력"
          >
            <BellIcon />
            <span className="topbar__badge" aria-hidden />
          </button>
          {notifOpen && (
            <div className="topbar__notif-popover" role="dialog" aria-label="알림">
              <header className="topbar__notif-head">
                <strong>알림</strong>
                <button
                  type="button"
                  className="topbar__notif-close"
                  onClick={() => setNotifOpen(false)}
                  aria-label="닫기"
                >
                  ✕
                </button>
              </header>

              {/* 현장 게시판 섹션 */}
              <section className="topbar__notif-section">
                <div className="topbar__notif-section-head">
                  <span>📋 현장 게시판</span>
                  <em>최근 {posts.length}건</em>
                </div>
                {posts.length === 0 ? (
                  <p className="topbar__notif-empty">게시글이 없습니다.</p>
                ) : (
                  <ul className="topbar__notif-list">
                    {posts.map((p) => (
                      <li key={p.id} className="topbar__notif-item">
                        <span className={'topbar__notif-cat topbar__notif-cat--' + categoryClass(p.category)}>
                          {p.category}
                        </span>
                        <span className="topbar__notif-title" title={p.title}>{p.title}</span>
                        <span className="topbar__notif-meta">
                          {p.author} · {p.date.slice(5)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* 알림톡 발송 이력 섹션 */}
              <section className="topbar__notif-section">
                <div className="topbar__notif-section-head">
                  <span>💬 알림톡 발송</span>
                  <em>최근 {logs.length}건</em>
                </div>
                {logs.length === 0 ? (
                  <p className="topbar__notif-empty">발송 내역이 없습니다.</p>
                ) : (
                  <ul className="topbar__notif-list">
                    {logs.map((l) => {
                      const ch = l.channel === 'KAKAO' ? '카톡' : l.channel === 'SMS' ? 'SMS' : l.channel ?? '알림';
                      const preview = (l.body ?? '').slice(0, 36);
                      return (
                        <li key={l.id} className="topbar__notif-item">
                          <span className="topbar__notif-cat topbar__notif-cat--kakao">
                            {ch}
                          </span>
                          <span className="topbar__notif-title" title={l.body}>
                            {l.toName} — {preview}
                          </span>
                          <span className="topbar__notif-meta">
                            {l.sentAt.slice(5, 16).replace('T', ' ')}
                            {l.status === 'FAILED' && <span className="topbar__notif-fail"> · 실패</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>

        <div className="topbar__profile" ref={menuRef}>
          <button
            className="topbar__profile-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="topbar__avatar">{getInitials(user?.name)}</span>
            <span className="topbar__profile-name">{user?.name ?? '관리자'}</span>
          </button>

          {menuOpen && (
            <div className="topbar__menu" role="menu">
              <div className="topbar__menu-head">
                <div className="topbar__menu-avatar" aria-hidden>
                  {getInitials(user?.name)}
                </div>
                <p className="topbar__menu-name">{user?.name ?? '관리자'}</p>
                {user?.role && (
                  <span className="topbar__menu-role-chip">
                    {roleLabel(user.role)}
                  </span>
                )}
                {user?.companyName && (
                  <p className="topbar__menu-company">{user.companyName}</p>
                )}
                {user?.email && (
                  <p className="topbar__menu-email">{user.email}</p>
                )}
              </div>

              {viewMode === 'HQ' && (
                <>
                  <div className="topbar__menu-divider" />

                  <button
                    className="topbar__menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/settings?tab=account');
                    }}
                  >
                    <span className="topbar__menu-item-icon" aria-hidden>
                      <ContactIcon size={16} />
                    </span>
                    <span>계정 설정</span>
                    <span className="topbar__menu-item-arrow" aria-hidden>›</span>
                  </button>
                  <button
                    className="topbar__menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/settings?tab=company');
                    }}
                  >
                    <span className="topbar__menu-item-icon" aria-hidden>
                      <SiteIcon size={16} />
                    </span>
                    <span>회사 정보</span>
                    <span className="topbar__menu-item-arrow" aria-hidden>›</span>
                  </button>
                </>
              )}

              <div className="topbar__menu-divider" />

              <button className="topbar__menu-item topbar__menu-item--danger" onClick={handleLogout}>
                <span className="topbar__menu-item-icon" aria-hidden>
                  <LogoutIcon size={16} />
                </span>
                <span>로그아웃</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function formatKoreanDate(d: Date) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  return `${y}.${m}.${dd}(${days[d.getDay()]})`;
}

function getInitials(name?: string) {
  if (!name) return 'U';
  return name.charAt(0);
}

function roleLabel(role: 'OWNER' | 'MANAGER' | 'STAFF') {
  switch (role) {
    case 'OWNER':
      return '대표 관리자';
    case 'MANAGER':
      return '현장담당자';
    case 'STAFF':
      return '실무자';
  }
}

function categoryClass(c: BoardPostLite['category']): string {
  switch (c) {
    case '공지': return 'notice';
    case '안전': return 'safety';
    case '일정': return 'schedule';
    case '자재': return 'material';
  }
}


/**
 * 현재 날씨가 위험 조건인지 판단해 안내 문구를 반환.
 * 평상시(맑음/흐림 등) 또는 안전한 기온 → null.
 */
function weatherRiskHint(kind: WeatherKind, t: number): string | null {
  if (kind === 'thunder') return '뇌우 — 안전공지 필요';
  if (kind === 'snow') return '눈 — 결빙 주의 안내';
  if (kind === 'rain') return '우천 — 안전공지 발송';
  if (kind === 'fog') return '안개 — 시야 제한 안내';
  if (t >= 33) return '폭염 — 휴게시간 안내';
  if (t <= -8) return '한파 — 보온·동상 주의';
  return null;
}
