import { ReactNode, useEffect } from 'react';
import './Modal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 헤더 우측에 표시할 보조 정보 (배지 등) */
  headerRight?: ReactNode;
  /** 모달 폭. 기본 720px */
  width?: number;
  children: ReactNode;
  /** 하단 액션 영역 (저장/취소 버튼들) */
  footer?: ReactNode;
}

/**
 * 가운데 정렬 모달 — Esc 닫기 + 백드롭 클릭 닫기
 */
export function Modal({ open, onClose, title, subtitle, headerRight, width = 720, children, footer }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <div className="modal__title-wrap">
            <h2 className="modal__title">{title}</h2>
            {subtitle && <p className="modal__sub">{subtitle}</p>}
          </div>
          {headerRight && <div className="modal__head-right">{headerRight}</div>}
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}
