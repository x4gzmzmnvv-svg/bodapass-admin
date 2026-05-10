// FILE_VERSION 1777740000
/**
 * 협력업체 업종 / 공종 분류 — 건설산업기본법상 종합·전문건설업 분류 기준
 *
 *  - SiteCompany.specialty 필드에 들어갈 텍스트의 표준 옵션 모음
 *  - "기타" 선택 시 사용자가 자유 입력
 *  - 기존 데이터 호환 — specialty 가 표준 라벨에 없으면 그대로 표시 (legacy 자유입력)
 *
 * 사용처
 *  - SubcontractorInviteDialog (협력업체 초대 시 공사 분야)
 *  - JoinByCodeDialog          (코드로 합류 시 우리 분야)
 *  - 하도급 출역확인 popover (회사명 + 업종 표기)
 */

export interface SpecialtyOption {
  /** 업종 (대분류) */
  industry: string;
  /** 공종 / 주력 분야 (실제 specialty 값으로 저장) */
  specialty: string;
  /** 라벨 보조 — 현장 작업 분류 예시 */
  example?: string;
}

/** 표준 옵션 — 27개 + 기타 */
export const SPECIALTY_OPTIONS: SpecialtyOption[] = [
  // 지반조성·포장공사업
  { industry: '지반조성·포장공사업',         specialty: '토공사',                  example: '굴착·터파기·절토·성토·되메우기·흙막이' },
  { industry: '지반조성·포장공사업',         specialty: '포장공사',                example: '아스콘·콘크리트·투수포장·덧씌우기' },
  { industry: '지반조성·포장공사업',         specialty: '보링·그라우팅·파일공사',  example: '시추·천공·그라우팅·말뚝공사' },
  // 실내건축
  { industry: '실내건축공사업',              specialty: '실내건축공사',            example: '인테리어·수장·칸막이·목공' },
  // 금속·창호·지붕·건축물조립
  { industry: '금속·창호·지붕·건축물조립',  specialty: '금속구조물·창호·온실공사', example: '창호·유리·커튼월·방화문·자동문' },
  { industry: '금속·창호·지붕·건축물조립',  specialty: '지붕판금·건축물조립공사',  example: '지붕·판금·홈통·샌드위치패널' },
  // 도장·습식·방수·석공
  { industry: '도장·습식·방수·석공사업',     specialty: '도장공사',                example: '일반도장·뿜칠·차선도색·표면처리' },
  { industry: '도장·습식·방수·석공사업',     specialty: '습식·방수공사',           example: '미장·몰탈·코킹·타일·방수·조적' },
  { industry: '도장·습식·방수·석공사업',     specialty: '석공사',                  example: '석재외벽·돌붙임·돌포장·석축' },
  // 조경
  { industry: '조경식재·시설물공사업',       specialty: '조경식재공사',            example: '수목식재·잔디·초화류·종자뿜어붙이기' },
  { industry: '조경식재·시설물공사업',       specialty: '조경시설물설치공사',      example: '조경석·인조목·퍼걸러·놀이기구·분수' },
  // 철근·콘크리트
  { industry: '철근·콘크리트공사업',         specialty: '철근·콘크리트공사',       example: '철근가공·조립·콘크리트타설·거푸집·PSC' },
  // 구조물해체·비계
  { industry: '구조물해체·비계공사업',       specialty: '구조물해체·비계공사',     example: '건축물해체·구조물철거·비계·발판가설' },
  // 상하수도설비
  { industry: '상·하수도설비공사업',         specialty: '상하수도설비공사',        example: '상수관·취수·정수·송배수·하수관·우수관' },
  // 철도·궤도
  { industry: '철도·궤도공사업',             specialty: '철도·궤도공사',           example: '궤광·레일·분기부·침목·도상·거더설치' },
  // 철강구조물
  { industry: '철강구조물공사업',            specialty: '철강구조물공사',          example: '교량철구조물·건축철골·수문·철탑·강재육교' },
  // 수중·준설
  { industry: '수중·준설공사업',             specialty: '수중공사',                example: '수중암석파쇄·해저케이블·항로표지' },
  { industry: '수중·준설공사업',             specialty: '준설공사',                example: '항만·항로·운하·하천 준설' },
  // 승강기·삭도
  { industry: '승강기·삭도공사업',           specialty: '승강기설치공사',          example: '엘리베이터·에스컬레이터·기계식주차설비' },
  { industry: '승강기·삭도공사업',           specialty: '삭도설치공사',            example: '케이블카·리프트·삭도 신설·유지보수' },
  // 기계설비·가스
  { industry: '기계설비·가스공사업',         specialty: '기계설비공사',            example: '급배수·환기·공조·냉난방·플랜트배관·자동제어' },
  { industry: '기계설비·가스공사업',         specialty: '가스시설공사 제1종',      example: '도시가스공급·LPG 충전·고압가스배관' },
  // 가스·난방
  { industry: '가스·난방공사업',             specialty: '가스시설공사 제2종',      example: '일반 가스사용시설·고정가스용품 설치' },
  { industry: '가스·난방공사업',             specialty: '가스시설공사 제3종',      example: '1천만원 미만 온수보일러 부대시설' },
  { industry: '가스·난방공사업',             specialty: '난방공사 제1종',          example: '강철재/주철재/온수보일러·배관·온돌' },
  { industry: '가스·난방공사업',             specialty: '난방공사 제2종',          example: '태양열집열기·5만 kcal/h 이하 온수보일러' },
  { industry: '가스·난방공사업',             specialty: '난방공사 제3종',          example: '요업요로·금속요로 설치' },
];

/** "기타" 옵션 ID — select value 로 사용 */
export const SPECIALTY_OTHER = '__OTHER__';

/** specialty 문자열이 표준 목록에 있는지 */
export function isStandardSpecialty(s: string | undefined | null): boolean {
  if (!s) return false;
  return SPECIALTY_OPTIONS.some((o) => o.specialty === s);
}

/** specialty 문자열로 industry(대분류) 찾기 — 표시용 */
export function findIndustryOf(s: string | undefined | null): string | null {
  if (!s) return null;
  return SPECIALTY_OPTIONS.find((o) => o.specialty === s)?.industry ?? null;
}
