import { ReactNode, useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import './MacSelect.css';

export interface MacSelectOption {
  value: string | number;
  label: ReactNode;
  /** 좌측 아이콘 */
  icon?: ReactNode;
  /** 우측 보조 텍스트 (단축키 / 카운트 등) */
  hint?: ReactNode;
  /** 비활성 */
  disabled?: boolean;
  /** 이 항목을 그룹 헤더로 표시 (선택 불가, 작은 캡션) */
  header?: boolean;
}

interface Props {
  value: string | number;
  onChange: (next: any) => void;
  options: MacSelectOption[];
  /** 선택 안 됐을 때 placeholder */
  placeholder?: string;
  /** 메뉴 최소 폭 (옵션) */
  menuMinWidth?: number;
  className?: string;
  disabled?: boolean;
}

/**
 * macOS 스타일 드롭다운 — 이미지 spec
 *  · 블러 + 흰 반투명 배경 + 둥근 모서리
 *  · 항목 hover 시 시스템 블루 highlight (흰 텍스트)
 *  · 그룹 헤더 / 디바이더 / 단축키 (hint) 지원
 */
export function MacSelect({
  value,
  onChange,
  options,
  placeholder = '선택',
  menuMinWidth,
  className,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<'down' | 'up'>('down');
  // 메뉴는 position: fixed 로 띄워서 modal__body의 overflow 영역을 탈출 — coord 추적
  const [coord, setCoord] = useState<{ top: number; left: number; width: number } | null>(null);

  // 외부 클릭 / Esc 닫기 — 메뉴 (fixed) 와 trigger 둘 다 검사
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

  // 화면 아래 공간 부족하면 위로 띄움 + fixed 좌표 계산
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const update = () => {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      const space = window.innerHeight - r.bottom;
      const goUp = space < 280 && r.top > 280;
      setPos(goUp ? 'up' : 'down');
      setCoord({
        top: goUp ? r.top : r.bottom + 4,
        left: r.left,
        width: r.width,
      });
    };
    update();
    // 스크롤/리사이즈 시 좌표 갱신
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value && !o.header);

  return (
    <div
      ref={wrapRef}
      className={'mac-select' + (open ? ' is-open' : '') + (className ? ' ' + className : '')}
    >
      <button
        type="button"
        className={'mac-select__trigger' + (open ? ' is-open' : '')}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mac-select__current">
          {selected ? selected.label : <span className="mac-select__placeholder">{placeholder}</span>}
        </span>
        <span className="mac-select__chevron" aria-hidden>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1.5 L5 4.5 L9 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && coord && createPortal((() => {
        // 메뉴 폭 = trigger 폭 (또는 menuMinWidth). 화면 우측 끝을 넘지 않도록 left 클램프
        const w = Math.max(menuMinWidth ?? 0, coord.width);
        const maxLeft = Math.max(8, window.innerWidth - w - 8);
        const left = Math.min(coord.left, maxLeft);
        return (
        <div
          ref={menuRef}
          className={'mac-select__menu mac-select__menu--' + pos + ' mac-select__menu--fixed'}
          role="listbox"
          style={{
            position: 'fixed',
            top: pos === 'down' ? coord.top : 'auto',
            bottom: pos === 'up' ? window.innerHeight - coord.top + 4 : 'auto',
            left,
            right: 'auto',
            width: w,
          }}
        >
          {options.map((opt, i) => {
            if (opt.header) {
              return (
                <div key={'h-' + i} className="mac-select__header">
                  {opt.label}
                </div>
              );
            }
            const sel = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={
                  'mac-select__item' +
                  (sel ? ' is-selected' : '') +
                  (opt.disabled ? ' is-disabled' : '')
                }
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                disabled={opt.disabled}
                role="option"
                aria-selected={sel}
              >
                {opt.icon && <span className="mac-select__icon">{opt.icon}</span>}
                <span className="mac-select__label">{opt.label}</span>
                {opt.hint && <span className="mac-select__hint">{opt.hint}</span>}
              </button>
            );
          })}
        </div>
        );
      })(), document.body)}
    </div>
  );
}
