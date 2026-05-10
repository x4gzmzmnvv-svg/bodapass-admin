/**
 * 완료 토스트 — 의사결정이 끝나는 모든 버튼(승인/반려/확인/마감/지급/정산 등)
 *  에서 동일하게 사용하는 글로벌 토스트 유틸.
 *
 * 정책 (앞으로 모든 화면에 적용):
 *  · "확정 / 완료 / 마감 / 승인 / 반려 / 지급 / 정산" 처럼 「되돌리기 어려운 결정」 직후
 *    하단 우측에 1.8s 짧은 토스트로 결과를 노출한다.
 *  · 색상: 기본 검정 배경 + 흰 글씨. 실패/위험성 액션(반려·취소) 은 빨강 톤.
 *  · 화면 어느 곳에서나 호출 가능하도록 DOM 에 직접 주입 (React state 의존성 X).
 *
 * 사용:
 *   import { flashCompletion } from '../utils/completionToast';
 *   flashCompletion('월 공수마감 완료');
 *   flashCompletion('반려 처리되었습니다.', { tone: 'danger' });
 */

type ToastTone = 'ok' | 'danger' | 'plain';

const CONTAINER_ID = 'bodapass-completion-toast-root';

function ensureContainer(): HTMLElement {
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONTAINER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.position = 'fixed';
    el.style.right = '20px';
    el.style.bottom = '24px';
    el.style.zIndex = '9999';
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.gap = '8px';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
  }
  return el;
}

export function flashCompletion(
  message: string,
  opts: { tone?: ToastTone; durationMs?: number } = {},
) {
  if (typeof document === 'undefined') return; // SSR guard
  const tone = opts.tone ?? 'ok';
  const duration = opts.durationMs ?? 1800;

  const container = ensureContainer();
  const item = document.createElement('div');
  item.className = 'bodapass-completion-toast bodapass-completion-toast--' + tone;
  item.textContent = (tone === 'ok' ? '✓ ' : tone === 'danger' ? '✕ ' : '') + message;

  // Inline style — 페이지별 CSS 누락 시도 동작 보장
  item.style.padding = '10px 16px';
  item.style.background = tone === 'danger' ? '#b91c1c' : '#111827';
  item.style.color = 'white';
  item.style.fontSize = '13px';
  item.style.fontWeight = '600';
  item.style.borderRadius = '8px';
  item.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.18)';
  item.style.letterSpacing = '-0.01em';
  item.style.opacity = '0';
  item.style.transform = 'translateY(8px)';
  item.style.transition = 'opacity 0.18s ease-out, transform 0.18s ease-out';
  item.style.pointerEvents = 'auto';

  container.appendChild(item);
  // 다음 프레임에 transition 적용 (in)
  requestAnimationFrame(() => {
    item.style.opacity = '1';
    item.style.transform = 'translateY(0)';
  });

  // duration 후 제거
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(-4px)';
    setTimeout(() => {
      if (item.parentElement) item.parentElement.removeChild(item);
    }, 220);
  }, duration);
}

/** 헬퍼 — 명시적 상태별 단축 호출 */
export const completionToast = {
  ok: (msg: string) => flashCompletion(msg, { tone: 'ok' }),
  danger: (msg: string) => flashCompletion(msg, { tone: 'danger' }),
  info: (msg: string) => flashCompletion(msg, { tone: 'plain' }),
};
