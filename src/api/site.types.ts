/**
 * 현장(Site) 도메인 타입 — 와이어프레임 007/009/025 기준
 *
 * 현장은 "관리자가 등록한 공사 현장"이고, 한 회사가 여러 현장을 가질 수 있습니다.
 * 각 현장은:
 *  - 기본 정보 (이름·소재지·우편번호)
 *  - 도급 정보 (도급종류·도급금액·계약일·기간 등)
 *  - 인원/담당자 정보 (현장담당자·안전관리자·품질시험자)
 *  - 발주처·공정률·인원수 요약 (대시보드용)
 */

/** 도급 종류 — 와이어프레임 007의 드롭다운 */
export type ContractKind = '원도급' | '하도급' | '단가도급' | '공동도급';

/** 현장 상태 */
export type SiteStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'PAUSED';

/** 인원 카테고리 — 와이어프레임 008의 "형틀/조적/설비/전기" */
export interface SiteWorkerCount {
  formwork: number; // 형틀
  masonry: number; // 조적
  facility: number; // 설비
  electric: number; // 전기
  /** 그 외 직종 */
  other?: number;
}

export interface Site {
  id: string;
  name: string;
  contractKind: ContractKind;
  contractDescription?: string;
  contractAmount: number;
  contractDate: string;
  startDate: string;
  endDate: string;
  bidNoticeDate?: string;
  insuranceBaseDate?: string;
  client: string;
  clientType?: string;
  zipCode?: string;
  address: string;
  addressDetail?: string;
  manager: string;
  managerPhone: string;
  managerFax?: string;
  siteAgent?: { name?: string; phone?: string };
  safetyOfficer?: { name?: string; phone?: string };
  qualityInspector?: { name?: string; phone?: string };
  scale?: 'SMALL' | 'NORMAL';
  ownerCompanyId: string;
  inviteCode?: string;
  inviteCodeExpiresAt?: string;
  progressPercent: number;
  workerCount: SiteWorkerCount;
  workDescription?: string;
  status: SiteStatus;
  createdAt: string;
  geofence?: SiteGeofence;
  attendanceConfirmMode?: 'SITE_OFFICE' | 'HQ_DIRECT';
}

// ───────── 지오펜싱 ─────────

export type LocationRequirement = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
export type OutOfBoundsPolicy = 'BLOCK' | 'WARN' | 'ALLOW';
export type GeofenceResult = 'INSIDE' | 'OUTSIDE' | 'NO_LOCATION' | 'LOW_ACCURACY';

export interface SiteGeofence {
  lat: number;
  lng: number;
  radiusM: number;
  gpsTolerance: number;
  locationRequired: LocationRequirement;
  outOfBoundsPolicy: OutOfBoundsPolicy;
}

export interface GlobalGeofencePolicy {
  defaultRadiusM: number;
  defaultGpsTolerance: number;
  defaultLocationRequired: LocationRequirement;
  defaultOutOfBoundsPolicy: OutOfBoundsPolicy;
}

export interface CreateSiteRequest {
  name: string;
  contractKind: ContractKind;
  contractDescription?: string;
  contractAmount: number;
  contractDate: string;
  startDate: string;
  endDate: string;
  bidNoticeDate?: string;
  insuranceBaseDate?: string;
  client: string;
  zipCode?: string;
  address: string;
  addressDetail?: string;
  manager: string;
  managerPhone: string;
  managerFax?: string;
  siteAgent?: { name?: string; phone?: string };
  safetyOfficer?: { name?: string; phone?: string };
  qualityInspector?: { name?: string; phone?: string };
}

export interface ListSitesResponse {
  sites: Site[];
  total: number;
}

export interface SiteCreateResponse {
  site: Site;
  message: string;
}

// ───────── 회사 ─────────

export interface Company {
  id: string;
  name: string;
  bizNo?: string;
  companyCode?: string;
  representative?: string;
  ownerUserId?: string;
  createdAt: string;
}

// ───────── SiteCompany (협력 관계) ─────────

export type SiteCompanyRole = '원도급' | '하도급' | '협력사' | '감리' | '품질' | '안전';
export type SiteCompanyStatus = 'INVITED' | 'ACTIVE' | 'PAUSED' | 'TERMINATED' | 'BLOCKED';

export interface SiteCompany {
  id: string;
  siteId: string;
  companyId: string;
  role: SiteCompanyRole;
  trade?: string;
  /** @deprecated trade 로 대체 */
  specialty?: string;
  joinedAt: string;
  status: SiteCompanyStatus;
  contractAmount?: number;
  startDate?: string;
  endDate?: string;
  progressPercent?: number;
}

// ───────── 반장(현장 책임자) ─────────

/**
 * 반장 라이프사이클 상태 — 7단계.
 *  · INVITED              : SMS/카톡 초대 발송 직후
 *  · PENDING_REGISTRATION : 초대 링크 접속, 가입 진행 중
 *  · REGISTERED           : 가입 완료, 현장 미배정 상태 (대기풀)
 *  · ASSIGNED             : 1개 이상 현장 배정 (착공 대기)
 *  · ACTIVE               : 최근 7일 내 출역·관리 활동 있음
 *  · INACTIVE             : 30일 이상 활동 없음 (휴면)
 *  · SUSPENDED            : 관리자가 일시 정지
 */
export type ForemanStatus =
  | 'INVITED'
  | 'PENDING_REGISTRATION'
  | 'REGISTERED'
  | 'ASSIGNED'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'SUSPENDED';

/** 현장 배정 시 반장 역할 */
export type ForemanSiteRole = '주반장' | '보조반장' | '임시반장';

/** 권한 프리셋 */
export type ForemanPermissionPreset = 'FULL' | 'STANDARD' | 'LIMITED' | 'CUSTOM';

/** CUSTOM 프리셋 시 사용 — 세부 권한 토글 */
export interface ForemanPermissions {
  /** 팀원 등록 가능 */
  memberRegister?: boolean;
  /** 얼굴등록 요청 가능 */
  faceRegisterRequest?: boolean;
  /** 출근처리 가능 */
  attendanceConfirm?: boolean;
  /** 수동공수 요청 가능 */
  manualGongsuRequest?: boolean;
  /** 안전공지 발송 가능 */
  safetyNoticeSend?: boolean;
  /** 팀원 정보 수정 가능 */
  memberInfoEdit?: boolean;
  /** 노임 결재 권한 */
  payApproval?: boolean;
  /** 서류 발행 권한 */
  documentIssue?: boolean;
}

export interface Foreman {
  id: string;
  name: string;
  phone: string;
  /** @deprecated ForemanSite 로 이전 — 주 배정 캐시 */
  siteId: string;
  /** @deprecated ForemanSite 로 이전 */
  siteCompanyId?: string;
  /** 직종 (담당 공종) */
  role?: string;
  /** 프로필 이미지 URL */
  avatarUrl?: string;
  /** 알림 채널 */
  notifyChannel: 'SMS' | 'KAKAO';
  /** 초대 발송 시각 */
  invitedAt: string;
  /** 호환용 — status >= REGISTERED 일 때 true */
  registered: boolean;
  /** 7단계 상세 상태 */
  status?: ForemanStatus;
  /** 가입 완료 시각 */
  registeredAt?: string;
  /** 마지막 활동 시각 (출역/앱 로그인) */
  lastActiveAt?: string;
  /** 최초 소속 회사 */
  defaultCompanyId?: string;
}

/**
 * ForemanSite — 반장 × 현장 다대다 배정.
 *  한 반장이 여러 현장에 배정될 수 있고, 한 현장에 여러 반장이 있을 수 있다.
 */
export interface ForemanSite {
  id: string;
  foremanId: string;
  siteId: string;
  companyId: string;
  /** SiteCompany.id 참조 */
  siteCompanyId?: string;
  /** 담당 공종 (형틀, 철근 등) */
  trade: string;
  /** 역할 — 주반장 / 보조반장 / 임시반장 */
  role: ForemanSiteRole;
  /** 권한 프리셋 */
  permissionPreset: ForemanPermissionPreset;
  /** CUSTOM 프리셋 시만 사용 */
  permissions?: ForemanPermissions;
  /** 시작일 / 종료일 */
  startDate: string;
  endDate: string;
  /** 일당 (반장 본인) */
  dailyWage?: number;
  /** 필요 인원 (이끌 팀원 수) */
  headcount?: number;
  /** 주 담당 여부 — true 면 이 반장의 「대표 현장」 */
  isPrimary: boolean;
  /** 배정 시각 / 종료 시각 */
  assignedAt: string;
  endedAt?: string;
  /** 반장 앱 승인 상태 */
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ACTIVE' | 'TERMINATED';
  approvedAt?: string;
  /** 비고 */
  note?: string;
}

/** 반장 등록 요청 */
export interface CreateForemenRequest {
  siteId: string;
  channel: 'SMS' | 'KAKAO';
  /** 옵션 — 사용자가 편집한 발송 메시지 본문 (없으면 서버 기본 템플릿 사용) */
  message?: string;
  foremen: Array<{
    name: string;
    phone: string;
    role?: string;
    /** 옵션 — 소속 회사 */
    companyId?: string;
    /** 옵션 — 담당 공종 */
    trade?: string;
    /** 옵션 — 역할 */
    siteRole?: ForemanSiteRole;
    /** 옵션 — 권한 프리셋 */
    permissionPreset?: ForemanPermissionPreset;
  }>;
}

export interface CreateForemenResponse {
  created: Foreman[];
  failures: Array<{ name: string; phone: string; reason: string }>;
}

export interface ListForemenResponse {
  foremen: Foreman[];
}

export interface ListForemanSitesResponse {
  foremanSites: ForemanSite[];
}

/** 반장 누적 KPI — attendance bucket 으로부터 산출 */
export interface ForemanMetrics {
  foremanId: string;
  /** 오늘 출역 처리 수 */
  todayAttendanceCount: number;
  /** 이번 달 출역 처리 수 */
  monthAttendanceCount: number;
  /** 얼굴인식 성공률 (0~1) */
  faceRecognitionRate: number;
  /** 수동처리율 (0~1) */
  manualProcessingRate: number;
  /** GPS 정상률 (0~1) */
  gpsValidRate: number;
  /** 최근 7일 수동처리 건수 */
  recentManualCount: number;
  /** 최근 7일 GPS 미수집 건수 */
  recentGpsMissingCount: number;
  /** 누적 출역 건수 */
  totalAttendanceCount: number;
  /** 산출 기준일 */
  calculatedAt: string;
}

// ───────── 대시보드 요약 ─────────

export interface DashboardSummary {
  siteCount: number;
  foremanCount: number;
  totalAttendedToday: number;
  current?: {
    site: Site;
    foremen: Foreman[];
    kpi: {
      progressPercent: number;
      annualPayoutKrw: number;
      pendingPayoutKrw: number;
      deductionKrw: number;
      incomeTaxKrw: number;
      hourFundKrw: number;
      severanceKrw: number;
      attendedToday: number;
      activeSites: number;
      idleCount: number;
    };
  };
}
