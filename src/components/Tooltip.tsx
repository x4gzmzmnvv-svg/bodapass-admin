// FILE_VERSION 1777810010
/**
 * 공용 Tooltip — 호버/포커스 시 라벨 표시
 *
 * 사용 예
 *  <Tooltip text="기초안전교육 미이수자">
 *    <span>⚠</span>
 *  </Tooltip>
 *
 *  <Tooltip
 *    title="현장 밖 출근 시도"
 *    body={<>거리 <strong>233m</strong> 밖 · 정확도 ±15m</>}
 *    tone="danger"
 *  >
 *    <span>⚠</span>
 *  </Tooltip>
 *
 * 디자인 정책
 *  · 다크 배경 (#0f172a) + 흰 글자
 *  · 툴팁 본문 padding 8 12, font-size 11.5px, line-height 1.5
 *  · 화살표 6px, target 위쪽 8px gap
 *  · tone — 'default'(다크) / 'danger'(빨강) / 'warning'(노랑) / 'info'(파랑) / 'success'(초록)
 *  · placement — 'top'(기본) / 'bottom' / 'left' / 'right'
 */

import { ReactNode, useId, useRef, useState, useEffect } from 'react';
import './Tooltip.css';

export type TooltipTone = 'default' | 'danger' | 'warning' | 'info' | 'success';
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  /** 단일 라인 라벨 — body 가 없을 때 사용 */
  text?: ReactNode;
  /** 헤더 (title) + 본문 (body) 형태로 노출하고 싶을 때 */
  title?: ReactNode;
  body?: ReactNode;
  /** 색상 톤 */
  tone?: TooltipTone;
  /** 표시 방향 (기본 top) */
  placement?: TooltipPlacement;
  /** 호버 트리거 — title= 처럼 단순 라벨 */
  children: ReactNode;
  /** 비활성화 — 동적으로 끄고 싶을 때 */
  disabled?: boolean;
}

export function Tooltip({
  text,
  title,
  body,
  tone = 'default',
  placement = 'top',
  children,
  disabled = false,
}: Props) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  // 포커스 / 호버 이벤트
  function show() { if (!disabled) setOpen(true); }
  function hide() { setOpen(false); }

  // ESC 로 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (disabled) return <>{children}</>;

  return (
    <span
      ref={wrapRef}
      className="tlp"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span className="tlp__trigger" aria-describedby={open ? id : undefined}>
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`tlp__bubble tlp__bubble--${tone} tlp__bubble--${placement}`}
        >
          {title && <span className="tlp__title">{title}</span>}
          {body && <span className="tlp__body">{body}</span>}
          {!title && !body && <span className="tlp__body">{text}</span>}
          {text && (title || body) && <span className="tlp__hint">{text}</span>}
          <span className={`tlp__arrow tlp__arrow--${placement}`} aria-hidden />
        </span>
      )}
    </span>
  );
}
