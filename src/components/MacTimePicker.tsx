import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './MacTimePicker.css';

interface Props {
  /** "HH:MM" 형식 (예: "09:00"). 빈 문자열이면 09:00 으로 표시. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  /** 분 단위 그리드 (기본 5분). */
  step?: 1 | 5 | 10 | 15 | 30;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * macOS Sequoia 톤 시간 입력 — 시/분 두 컬럼 휠.
 *  · trigger: translucent 그레이 pill + 우측 ⏱️ 아이콘
 *  · 메뉴: liquid glass 머터리얼 + 시스템 블루 active pill
 *  · portal 로 document.body 에 렌더링 — ancestor transform/filter 영향 X
 */
export function MacTimePicker({ value, onChange, disabled, className, step = 5 }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoursColRef = useRef<HTMLDivElement>(null);
  const minutesColRef = useRef<HTMLDivElement>(null);
  const [coord, setCoord] = useState<{ top: number; left: number; width: number } | null>(null);

  const minutes = Array.from({ length: Math.floor(60 / step) }, (_, i) => i * step);

  const [hh, mm] = (() => {
    const m = (value || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return [9, 0];
    return [Math.max(0, Math.min(23, parseInt(m[1], 10))), Math.max(0, Math.min(59, parseInt(m[2], 10)))];
  })();

  const display = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  // 외부 클릭 / Esc 닫기
  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
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

  // 좌표 계산 (fixed positioning)
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const update = () => {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      setCoord({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // 메뉴 열릴 때 현재 선택값으로 자동 스크롤
  useLayoutEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      hoursColRef.current?.querySelector<HTMLElement>('.mtp__opt.is-selected')?.scrollIntoView({ block: 'center' });
      minutesColRef.current?.querySelector<HTMLElement>('.mtp__opt.is-selected')?.scrollIntoView({ block: 'center' });
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const setHour = (h: number) => {
    const next = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    onChange(next);
  };
  const setMinute = (m: number) => {
    const next = `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className={'mtp' + (className ? ' ' + className : '')}>
      <button
        type="button"
        className={'mtp__trigger' + (open ? ' is-open' : '')}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mtp__current">{display}</span>
        <span className="mtp__icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 4.5 V8 L10.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && coord && createPortal(
        (() => {
          const w = Math.max(180, coord.width);
          const maxLeft = Math.max(8, window.innerWidth - w - 8);
          const left = Math.min(coord.left, maxLeft);
          return (
            <div
              ref={menuRef}
              className="mtp__menu"
              role="listbox"
              style={{ position: 'fixed', top: coord.top, left, width: w }}
            >
              <div className="mtp__cols">
                <div ref={hoursColRef} className="mtp__col">
                  <div className="mtp__col-head">시</div>
                  <div className="mtp__col-body">
                    {HOURS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        className={'mtp__opt' + (h === hh ? ' is-selected' : '')}
                        onClick={() => setHour(h)}
                      >
                        {String(h).padStart(2, '0')}
                      </button>
                    ))}
                  </div>
                </div>
                <div ref={minutesColRef} className="mtp__col">
                  <div className="mtp__col-head">분</div>
                  <div className="mtp__col-body">
                    {minutes.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={'mtp__opt' + (m === mm ? ' is-selected' : '')}
                        onClick={() => setMinute(m)}
                      >
                        {String(m).padStart(2, '0')}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}
