import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './MacDatePicker.css';

interface Props {
  /** 'YYYY-MM-DD' (date) 또는 'YYYY-MM' (month) */
  value: string;
  onChange: (next: string) => void;
  /** 'date' (기본) | 'month' */
  type?: 'date' | 'month';
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** 최소/최대 날짜 (YYYY-MM-DD). 옵션 */
  min?: string;
  max?: string;
  /** trigger label override (없으면 value 표시) */
  format?: (v: string) => string;
}

const KOREAN_DOW = ['일', '월', '화', '수', '목', '금', '토'];
const KOREAN_MONTH = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

function pad(n: number) {
  return n < 10 ? '0' + n : '' + n;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function parseValue(v: string, type: 'date' | 'month') {
  if (!v) return null;
  const parts = v.split('-').map(Number);
  if (type === 'month') {
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    return { y: parts[0], m: parts[1], d: 1 };
  }
  if (parts.length < 3 || parts.some(isNaN)) return null;
  return { y: parts[0], m: parts[1], d: parts[2] };
}

/**
 * MacDatePicker — macOS 컨텍스트 메뉴 톤 날짜 선택기
 *  - 트리거: MacSelect 와 동일한 흰 pill (📅 아이콘 + 날짜 텍스트)
 *  - 팝업: 블러 흰 반투명 + 둥근 모서리 + 큰 그림자
 *  - 날짜 선택: 에머랄드 (#10B981) hover/active
 *  - "오늘" / "지우기" 푸터
 */
export function MacDatePicker({
  value,
  onChange,
  type = 'date',
  placeholder = '날짜 선택',
  className,
  disabled,
  min,
  max,
  format,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<'down' | 'up'>('down');

  const parsed = parseValue(value, type) ?? parseValue(todayStr(), 'date')!;
  const [viewYear, setViewYear] = useState(parsed.y);
  const [viewMonth, setViewMonth] = useState(parsed.m); // 1~12

  // value 가 바뀌면 view 도 그 달로 점프
  useEffect(() => {
    const p = parseValue(value, type);
    if (p) {
      setViewYear(p.y);
      setViewMonth(p.m);
    }
  }, [value, type]);

  // 외부 클릭 / Esc 닫기
  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 화면 아래 공간 부족하면 위로 띄움
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const space = window.innerHeight - r.bottom;
    setPos(space < 360 && r.top > 360 ? 'up' : 'down');
  }, [open]);

  // 달력 셀 계산
  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth - 1, 1);
    const padCount = first.getDay(); // 0=일
    const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
    const arr: Array<{ d: number; ym: string; isToday: boolean; isSelected: boolean; disabled: boolean } | null> = [];
    for (let i = 0; i < padCount; i++) arr.push(null);
    const tStr = todayStr();
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = viewYear + '-' + pad(viewMonth) + '-' + pad(d);
      const isDisabled = (min && ymd < min) || (max && ymd > max);
      arr.push({
        d,
        ym: ymd,
        isToday: ymd === tStr,
        isSelected: type === 'date' ? value === ymd : value === viewYear + '-' + pad(viewMonth),
        disabled: !!isDisabled,
      });
    }
    return arr;
  }, [viewYear, viewMonth, value, min, max, type]);

  function shiftMonth(delta: number) {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    setViewYear(y);
    setViewMonth(m);
  }

  function handlePick(ymd: string) {
    if (type === 'month') {
      onChange(ymd.slice(0, 7));
    } else {
      onChange(ymd);
    }
    setOpen(false);
  }

  function pickToday() {
    const t = todayStr();
    if (type === 'month') {
      onChange(t.slice(0, 7));
    } else {
      onChange(t);
    }
    setOpen(false);
  }
  function clear() {
    onChange('');
    setOpen(false);
  }

  const triggerLabel = (() => {
    if (!value) return <span className="mac-date__placeholder">{placeholder}</span>;
    if (format) return format(value);
    return value;
  })();

  // 월 선택 (type='month' 일 때 12개월 그리드 표시)
  const monthGrid = type === 'month';

  return (
    <div ref={wrapRef} className={'mac-date' + (open ? ' is-open' : '') + (className ? ' ' + className : '')}>
      <button
        type="button"
        className={'mac-date__trigger' + (open ? ' is-open' : '')}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg className="mac-date__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
          <line x1="4.5" y1="1" x2="4.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="9.5" y1="1" x2="9.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span className="mac-date__current">{triggerLabel}</span>
      </button>

      {open && (
        <div className={'mac-date__menu mac-date__menu--' + pos} role="dialog">
          {/* 헤더 — 년/월 + 이전/다음 */}
          <div className="mac-date__head">
            <button type="button" className="mac-date__nav" onClick={() => shiftMonth(-1)} aria-label="이전 달">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M6.5 1 L2.5 5 L6.5 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <strong className="mac-date__title">{viewYear}년 {KOREAN_MONTH[viewMonth - 1]}</strong>
            <button type="button" className="mac-date__nav" onClick={() => shiftMonth(1)} aria-label="다음 달">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 1 L7.5 5 L3.5 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>

          {monthGrid ? (
            // type='month' — 월 12개 그리드
            <div className="mac-date__month-grid">
              {KOREAN_MONTH.map((label, idx) => {
                const m = idx + 1;
                const ym = viewYear + '-' + pad(m);
                const sel = value === ym;
                return (
                  <button
                    key={m}
                    type="button"
                    className={'mac-date__month-cell' + (sel ? ' is-selected' : '')}
                    onClick={() => handlePick(viewYear + '-' + pad(m) + '-01')}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {/* 요일 헤더 */}
              <div className="mac-date__dow">
                {KOREAN_DOW.map((d, i) => (
                  <span key={i} className={'mac-date__dow-cell' + (i === 0 ? ' mac-date__dow-cell--sun' : '') + (i === 6 ? ' mac-date__dow-cell--sat' : '')}>{d}</span>
                ))}
              </div>
              {/* 일 그리드 */}
              <div className="mac-date__day-grid">
                {cells.map((c, i) => {
                  if (!c) return <span key={i} className="mac-date__day-cell mac-date__day-cell--pad" />;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={
                        'mac-date__day-cell' +
                        (c.isSelected ? ' is-selected' : '') +
                        (c.isToday ? ' is-today' : '') +
                        (c.disabled ? ' is-disabled' : '') +
                        ((i % 7) === 0 ? ' mac-date__day-cell--sun' : '') +
                        ((i % 7) === 6 ? ' mac-date__day-cell--sat' : '')
                      }
                      onClick={() => !c.disabled && handlePick(c.ym)}
                      disabled={c.disabled}
                    >
                      {c.d}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* 푸터 — 지우기 / 오늘 */}
          <div className="mac-date__foot">
            <button type="button" className="mac-date__foot-btn" onClick={clear}>지우기</button>
            <button type="button" className="mac-date__foot-btn mac-date__foot-btn--accent" onClick={pickToday}>오늘</button>
          </div>
        </div>
      )}
    </div>
  );
}
