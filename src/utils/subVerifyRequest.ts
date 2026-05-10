// FILE_VERSION 1777890000
/**
 * 하도급 출역확인 요청 — 발송 이력 (localStorage)
 *
 *  원도급이 미확인 하도급사에 「출역확인 부탁드립니다」 알림을 보낸 기록을 저장.
 *  실제 SMS·앱 푸시·이메일 발송은 추후 백엔드 연결 — 현재는 모의 발송 (이력만 적재).
 */

const STORAGE_KEY = 'bodapass.subVerifyRequests.v1';

export type SubVerifyChannel = 'APP' | 'SMS' | 'EMAIL';

export const CHANNEL_LABEL: Record<SubVerifyChannel, string> = {
  APP: '앱 푸시',
  SMS: 'SMS',
  EMAIL: '이메일',
};

export interface SubVerifyRequestRecord {
  /** 'YYYY-MM-DD' — 어느 날짜의 출력에 대한 요청인지 */
  date: string;
  /** 어느 현장 */
  siteId: string;
  siteName: string;
  /** 어느 site_company (하도급) 에게 보냈는지 */
  siteCompanyId: string;
  companyName: string;
  channels: SubVerifyChannel[];
  message: string;
  sentAt: string;       // ISO
  sentByName: string;
}

export function loadSubVerifyRequests(): SubVerifyRequestRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SubVerifyRequestRecord[];
  } catch {
    return [];
  }
}

export function saveSubVerifyRequest(rec: SubVerifyRequestRecord): void {
  try {
    const arr = loadSubVerifyRequests();
    arr.push(rec);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('출역확인 요청 이력 저장 실패', e);
  }
}

/** 같은 날짜·같은 site_company 에 대한 마지막 요청 (있으면) */
export function findLastRequest(
  date: string,
  siteCompanyId: string,
): SubVerifyRequestRecord | null {
  const arr = loadSubVerifyRequests().filter(
    (r) => r.date === date && r.siteCompanyId === siteCompanyId,
  );
  if (arr.length === 0) return null;
  return arr[arr.length - 1];
}

/** 기본 메시지 빌더 — 모달 열릴 때 placeholder 로 채움 */
export function buildDefaultMessage(args: {
  siteName: string;
  companyName: string;
  date: string;
  memberCount: number;
  todayTotal: number;
  todayWorking: number;
  senderName: string;
}): string {
  const ymd = args.date.replaceAll('-', '.');
  return [
    `[출역확인 요청] ${args.siteName}`,
    '',
    `${ymd} 일자 출력 인원 확인 부탁드립니다.`,
    '',
    `· 귀사(${args.companyName}) 등록 인원: ${args.memberCount}명`,
    `· 오늘 출근: ${args.todayTotal}명 (근무 중 ${args.todayWorking}명)`,
    '',
    '확정 후 「출역확인」 버튼을 눌러주시기 바랍니다.',
    '· 마감: 매일 18:00',
    `· 요청: ${args.senderName}`,
  ].join('\n');
}
