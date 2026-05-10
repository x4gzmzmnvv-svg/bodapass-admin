/**
 * 팀원(근로자) 도메인 타입 — 와이어프레임 013~023.png + 전자동의서.pdf + 직무범위.xlsx
 *
 * 등록 방식 (와이어프레임 011/016):
 *  - IN_PERSON  : 관리자가 직접 입력
 *  - ONLINE     : 관리자가 이름+휴대폰만 입력 → SMS 발송 → 팀원이 직접 등록
 *  - OFFICE     : 공무담당자가 사무실에서 등록 (와이어프레임 019)
 */

export type IdType = 1 | 2 | 3;
export type RegistrationMode = 'IN_PERSON' | 'ONLINE' | 'OFFICE';
export type MemberStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING';

/**
 * 임금 지급 계좌 명의자 유형 — Employment 별로 다를 수 있음.
 *  · 'OWN'     : 본인 명의 계좌 → T1
 *  · 'FAMILY'  : 가족 명의 계좌 → T2/T3 (배우자·직계존비속)
 *  · 'FOREMAN' : 반장 명의 계좌 → T2/T3 (반장이 일괄 수령 후 분배)
 */
export type PaymentAccountType = 'OWN' | 'FAMILY' | 'FOREMAN';

/**
 * Employment(채용 관계)의 상태.
 *  · ACTIVE     : 재직 중
 *  · PAUSED     : 일시 중단 (휴직·자재 부족 등)
 *  · TERMINATED : 이탈
 */
export type EmploymentStatus = 'ACTIVE' | 'PAUSED' | 'TERMINATED';

/**
 * 직종은 직무범위.xlsx 의 303개 직종 중 하나.
 *  - 빠른 선택을 위해 상위 직종을 별도 상수로 두고,
 *  - 실제 입력은 src/components/RoleSelect 로 검색·선택.
 *  - 타입은 string 으로 풀어 자유롭게 직종을 받을 수 있게 한다.
 */
export type WorkerRole = string;

/** 4대보험 가입 여부 */
export interface InsuranceFlags {
  /** 국민연금 */
  pension: boolean;
  /** 건강보험 */
  health: boolean;
  /** 고용보험 */
  employment: boolean;
  /** 산재보험 */
  accident: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  phone: string;
  role: WorkerRole;
  siteId: string;
  /** 어떤 (현장, 회사) 페어 소속인지 — 새 모델 (Company → Site → SiteCompany → Worker) */
  siteCompanyId?: string;
  /** 이 팀원을 관리하는 반장 ID (현장담당자 배정 시엔 비어 있음) */
  foremanId?: string;
  /** 현장담당자(소장)가 직접 관리 — 반장 대신 현장담당자가 얼굴 인식 등 처리 */
  assignedToSiteManager?: boolean;
  dailyWage: number;
  idType: IdType;
  idNumberMasked: string;
  /** 평문 주민등록번호 (사회보험·노임대장 처리 권한이 있을 때 서버에서 함께 반환) */
  idNumberRaw?: string;
  bankName: string;
  accountMasked: string;
  /** 평문 계좌번호 (위와 동일) */
  accountNumberRaw?: string;
  registrationMode: RegistrationMode;
  status: MemberStatus;
  facePhotoUrl?: string;
  joinedAt: string;

  /** 이탈일 (없으면 재직 중) */
  leftAt?: string;
  /** 4대보험 가입 여부 — 일용직은 산재만 의무, 나머지는 선택 */
  insurance?: InsuranceFlags;
  /** 기초안전교육 이수 여부 (건설현장 의무) */
  safetyEduCompleted?: boolean;
  /** 근로계약서 체결 여부 — 추후 전자 계약 연동 시 사용 */
  contractSigned?: boolean;
  /** 계약 체결 일시 */
  contractSignedAt?: string;
  /** 얼굴인증 완료 여부 — 출퇴근 본인확인용 */
  faceVerified?: boolean;

  /**
   * 워커 관리번호 — 사람 1명당 1개 영구 발급. 형식: M-26-00123 / F-26-00456
   *  · 회사·현장 무관, 한 번 발급되면 변경 불가
   *  · 회사 간 출역·임금·교육이수 누적은 모두 이 코드 기반
   *  · 자세한 정책은 docs/identity-policy.md 참조
   */
  workerCode?: string;

  /**
   * 신뢰등급 (Trust Tier) — 신원 검증 완료 정도
   *  T1: 얼굴+신분증+본인통장 (정식)     → 4대보험·세금 자동
   *  T2: 얼굴+신분증+가족·반장통장 (부분) → 4대보험·세금 자동, 임금만 대리
   *  T3: 얼굴만 (제한)                    → 출역·임금만 추적, 4대보험·세금 X
   *  T4: 별도 출입기록만 (시스템 외부)   → 본 인터페이스엔 등장 X
   */
  trustTier?: 1 | 2 | 3;

  /**
   * 비과세 소득 항목 — 월 단위 (원). 보험료·소득세 산정에서 제외.
   *  · meal      : 식대 (월 20만원 한도)
   *  · vehicle   : 자가운전보조금 (월 20만원 한도)
   *  · travel    : 출장비·차량유지비 (조건부)
   *  · childcare : 출산·보육수당 (월 10만원 한도)
   *  · other     : 기타 비과세
   * 「과세 보수」 = 월 지급액 - 비과세 합계 → 보험료/세금 산정 기준
   */
  nontaxable?: {
    meal?: number;
    vehicle?: number;
    travel?: number;
    childcare?: number;
    other?: number;
  };
}

// ───────── Employment (채용 관계) ─────────

/**
 * 채용 관계 — 한 워커(Worker)가 한 회사(Company)의 한 현장(Site)에서 일하는 단위.
 * 같은 워커가 여러 회사·현장에서 일하면 Employment 행이 여러 개 생긴다.
 *
 *  · 내부 키: (companyId + workerId + siteId) 페어로 unique
 *  · UI 표시: workerCode + companyCode + 현장명 조합
 *  · 임금·출역·세금은 모두 Employment 단위로 누적되며,
 *    워커 마스터(Worker)에서는 합산 통계만 계산.
 *
 * 향후 TeamMember 를 Worker(마스터) + Employment(관계)로 분리할 때의 형식.
 * 현재는 TeamMember 가 두 역할을 모두 표현하지만, 신규 코드는 가능한 이 형식으로 작성.
 */
export interface Employment {
  /** employmentId — 채용 관계 행의 PK */
  id: string;
  /** 내부 FK — Company.id (UI 표시는 companyCode) */
  companyId: string;
  /** 내부 FK — Worker.id (UI 표시는 workerCode) */
  workerId: string;
  /** 내부 FK — Site.id */
  siteId: string;
  /** 내부 FK — 같은 회사 내 반장의 Employment.id (자기 참조). 미배정이면 비워둠 */
  foremanId?: string;
  /** 직종 — '형틀', '철근', '전기', '미장' 등 (직무범위.xlsx 의 303개 직종) */
  trade?: WorkerRole;
  /** 일당 (원) */
  dailyWage: number;
  /** 채용 시작일 (YYYY-MM-DD) */
  startDate: string;
  /** 채용 종료일 — 없으면 재직 중 */
  endDate?: string;
  status: EmploymentStatus;
  /**
   * 임금 지급 계좌 명의자 유형. Employment 별로 다를 수 있음.
   * (한 워커가 여러 회사에 채용된 경우, 각 회사별로 다르게 설정 가능)
   */
  paymentAccountType: PaymentAccountType;
  /**
   * 채용 시점의 신원 검증 등급(Trust Tier) 스냅샷.
   * Worker.trustTier 와 별개로 보존하는 이유는,
   * 채용 후 워커의 트러스트 티어가 승급하더라도
   * 「이 채용을 시작할 때의 검증 수준」을 감사 로그로 남기기 위함.
   */
  identityTier: 1 | 2 | 3;
}

// ───────── 등록 요청 ─────────

export interface RegisterMemberRequest {
  mode: RegistrationMode;
  name: string;
  phone: string;
  role: WorkerRole;
  /** 배정 현장 — 미지정 시 「대기 인력 / 본사 직접 관리」 상태로 등록 */
  siteId?: string;
  /** 이 팀원을 관리할 반장 ID — 미지정 시 (assignToSiteManager 가 true 아니면) 사이트 첫 반장 자동 배정 */
  foremanId?: string;
  /** 현장담당자(소장) 직접 관리 모드 — 반장 자동 배정 비활성화 */
  assignToSiteManager?: boolean;
  dailyWage: number;

  /** 신분증 */
  idType: IdType;
  idNumber: string;
  idAddress?: string;

  /** 통장 */
  bankName: string;
  accountNumber: string;
  accountHolder: string;

  /** 이미지 (선택) */
  idImageId?: string;
  faceImageId?: string;
  bankImageId?: string;

  /** 서명 (대면 모드만) */
  signatureBase64?: string;

  /** 전자동의서 PART 1·2·3 분리 동의 */
  agreedToPersonalInfo: boolean;
  agreedToBiometric: boolean;
  agreedToProxyDevice: boolean;
  agreedAt: string;

  /** 동의 완료 시 알림톡 발송 여부 (기본 true) */
  notifyConsentComplete?: boolean;

  /** 추가 정보 — 4대보험 가입 여부 (옵션) */
  insurance?: InsuranceFlags;
  /** 기초안전교육 이수 여부 (옵션) */
  safetyEduCompleted?: boolean;
  /** 기초안전교육 이수증 이미지 (data URL 또는 업로드 ID) — 옵션 */
  safetyCertImage?: string | null;
  /** 기초안전교육 이수증 파일명 (옵션) */
  safetyCertFileName?: string;
}

export interface RegisterMemberResponse {
  member: TeamMember;
  notificationSent: boolean;
  message: string;
}

// ───────── 온라인 초대 ─────────

export interface CreateOnlineInviteRequest {
  name: string;
  phone: string;
  role?: WorkerRole;
  siteId: string;
  /** 이 팀원이 등록 후 배정될 반장 ID */
  foremanId?: string;
}

export interface CreateOnlineInviteResponse {
  inviteId: string;
  inviteToken: string;
  inviteUrl: string;
  smsSentAt: string;
}

// ───────── 목록 / 상세 ─────────

export interface ListMembersQuery {
  siteId?: string;
  status?: MemberStatus | 'ALL';
  q?: string;
}

export interface ListMembersResponse {
  members: TeamMember[];
  totalActive: number;
}


export interface DeleteMemberResponse {
  memberId: string;
  deleted: boolean;
}

// ───────── 수정 ─────────

export interface UpdateMemberRequest {
  name?: string;
  phone?: string;
  role?: WorkerRole;
  siteId?: string;
  foremanId?: string;
  /** 현장담당자 직접 관리 모드 — 반장 자동 배정 비활성화 */
  assignToSiteManager?: boolean;
  dailyWage?: number;
  status?: MemberStatus;
  bankName?: string;
  /** 통장번호 — 평문으로 보내면 서버가 마스킹된 형태로 저장 */
  accountNumber?: string;
  /** 신분증 종류 — 1: 주민등록증, 2: 외국인등록증, 3: 기타 */
  idType?: IdType;
  /** 주민등록번호/신분증번호 — 평문으로 보내면 서버가 마스킹된 형태로 저장 */
  idNumber?: string;
  /** 이탈일 (없애려면 빈 문자열) */
  leftAt?: string;
  /** 4대보험 가입 여부 */
  insurance?: InsuranceFlags;
  /** 기초안전교육 이수 여부 */
  safetyEduCompleted?: boolean;
}


export interface UpdateMemberResponse {
  member: TeamMember;
  message: string;
}

// ───────── 이미지 업로드 ─────────

export interface UploadImageResponse {
  imageId: string;
  url: string;
}
