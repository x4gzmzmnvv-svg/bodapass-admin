/**
 * 알림톡 / SMS 메시지 템플릿
 *
 * 출처: "알림톡.pdf" 의 "[하루출근 개인정보 동의 완료 안내]" 본문.
 *
 *  - 팀원이 반장 기기로 직접 동의 + 전자서명을 마치면 본인 휴대폰으로 발송됨
 *  - 운영 정책상 발송 로그(수신 번호 / 발송 시각 / 성공 여부)는 1년 이상 보존
 *  - 도메인 보호를 위해 회사명·고객센터 번호는 빌드 환경 변수(VITE_COMPANY_*) 로
 *    덮어쓸 수 있게 했습니다.
 */

export interface ConsentNotificationContext {
  /** 팀원 이름 */
  memberName: string;
  /** 동의 시각 (ISO 또는 'YYYY-MM-DD HH:mm') */
  agreedAt: string;
  /** 회사명 */
  companyName?: string;
  /** 처리방침 URL */
  privacyUrl?: string;
  /** 고객센터 번호 */
  supportPhone?: string;
}

export interface NotificationMessage {
  /** 발송 채널 */
  channel: 'KAKAO' | 'SMS';
  /** 카카오 알림톡 템플릿 코드 (협력사 등록용) */
  templateCode: string;
  /** 메시지 제목 (SMS는 첫 줄로 사용) */
  title: string;
  /** 본문 */
  body: string;
}

const DEFAULT_COMPANY = (import.meta.env.VITE_COMPANY_NAME as string) ?? '하루출근';
const DEFAULT_PRIVACY_URL =
  (import.meta.env.VITE_PRIVACY_URL as string) ?? 'https://ilgampack.akoma.co.kr/privacy';
const DEFAULT_SUPPORT_PHONE =
  (import.meta.env.VITE_SUPPORT_PHONE as string) ?? '02-000-0000';

/** "[하루출근 개인정보 동의 완료 안내]" 알림톡 본문 빌드 */
export function buildConsentNotification(
  ctx: ConsentNotificationContext,
): NotificationMessage {
  const company = ctx.companyName ?? DEFAULT_COMPANY;
  const privacyUrl = ctx.privacyUrl ?? DEFAULT_PRIVACY_URL;
  const supportPhone = ctx.supportPhone ?? DEFAULT_SUPPORT_PHONE;
  const dateLabel = formatKstDate(ctx.agreedAt);

  const title = `[${company} 개인정보 동의 완료 안내]`;

  const body =
    `안녕하세요, ${ctx.memberName}님.\n` +
    `오늘 현장 관리자(반장) 기기를 이용하여 본인이 직접 진행하신 개인정보 처리 동의 및 전자서명이 정상적으로 완료되었습니다.\n` +
    `\n` +
    `■ 동의 주요 내용\n` +
    `* 일시 : ${dateLabel}\n` +
    `* 동의 내용\n` +
    `   - 개인정보 수집·이용\n` +
    `   - 민감정보(얼굴인식) 처리\n` +
    `* 이용 범위 : ${company}이 서비스를 제공하는 전국의 현장(현장 이동 시 재등록 없이 이용 가능)\n` +
    `* 이용 목적 : 출퇴근·근태 관리, 노무·급여 정산, 4대보험 등 법정 신고\n` +
    `* 보유 기간 : 관계 법령에 따른 보존 기간\n` +
    `\n` +
    `■ 안내 사항\n` +
    `* 귀하는 언제든지 동의를 철회할 수 있습니다.\n` +
    `* 얼굴인식 정보는 사진·영상 원본이 아닌 수치화된 특징값 형태로 안전하게 관리됩니다.\n` +
    `* 개인정보 처리방침은 ${privacyUrl} 에서 언제든지 확인할 수 있습니다.\n` +
    `\n` +
    `본 안내 내용이 사실과 다르거나, 본인이 직접 진행한 동의가 아닌 경우에는 아래 고객센터로 즉시 연락해 주시기 바랍니다.\n` +
    `\n` +
    `☎ 고객센터: ${supportPhone} ${company} 서비스 운영팀`;

  return {
    channel: 'KAKAO',
    templateCode: 'CONSENT_COMPLETE_V1',
    title,
    body,
  };
}

/** ISO/문자열 시각 → "YYYY년 M월 D일 HH:MM" */
function formatKstDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}년 ${m}월 ${dd}일 ${hh}:${mm}`;
}

// ───────── 발송 로그 (시연용 — 1년 이상 보존 정책 흉내) ─────────

export interface DispatchLog {
  id: string;
  channel: NotificationMessage['channel'];
  templateCode: string;
  toName: string;
  toPhone: string;
  body: string;
  sentAt: string;
  status: 'SENT' | 'FAILED';
  failReason?: string;
}

const DISPATCH_LOG_KEY = 'ilgampack_admin:dispatchLogs';

export function appendDispatchLog(entry: DispatchLog) {
  if (typeof window === 'undefined') return;
  const raw = window.localStorage.getItem(DISPATCH_LOG_KEY);
  const list: DispatchLog[] = raw ? JSON.parse(raw) : [];
  list.unshift(entry);
  // 최근 200건만 유지 (시연용 — 운영에서는 서버 측 로그)
  window.localStorage.setItem(DISPATCH_LOG_KEY, JSON.stringify(list.slice(0, 200)));
}

export function getDispatchLogs(): DispatchLog[] {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(DISPATCH_LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}
