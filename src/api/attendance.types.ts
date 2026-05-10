/**
 * 출퇴근 도메인 타입
 *
 * 핵심 규칙: 얼굴 인식이 통과된 출/퇴근 1쌍이면 근로 시간을 공수(工數)로 계산.
 *  - 표준 근로: 07:00 ~ 15:00 (8시간) = 1.0 공수
 *  - 4시간 단위로 0.5씩 가산: 4h=0.5, 8h=1.0, 12h=1.5, 16h+=2.0
 *  - 4시간 미만이면 0 공수 (출근 인정 X)
 *  - 강제 처리(MANUAL)는 사유가 있어야 하고 공수는 동일 규칙으로 계산
 *
 * 자세한 계산은 src/utils/gongsu.ts 의 `calcGongsu()` 참고.
 */

import type { WorkerRole } from './team.types';
import type { GeofenceResult } from './site.types';

export type AttendanceMethod = 'FACE' | 'MANUAL';
export type AttendanceStatus = 'BEFORE' | 'WORKING' | 'DONE';
export type DayResult = 'NORMAL' | 'LATE' | 'EARLY' | 'ABSENT' | 'OFF';

/** 출/퇴근 시점에 수집된 GPS 좌표 (지오펜싱 검증용) */
export interface AttendanceLocation {
  lat: number;
  lng: number;
  /** 측정 정확도 (m) — 작을수록 정확 */
  accuracy: number;
  /** 측정 시각 (ISO) */
  capturedAt: string;
}

/** 한 명의 어떤 날 출퇴근 기록 */
export interface AttendanceRecord {
  id: string;
  date: string; // 'YYYY-MM-DD'
  memberId: string;
  memberName: string;
  role: WorkerRole;
  siteId: string;

  /** 실제 출/퇴근 시각 (ISO) */
  checkInAt: string | null;
  checkOutAt: string | null;

  /** 인증 방법 */
  checkInMethod: AttendanceMethod | null;
  checkOutMethod: AttendanceMethod | null;

  /** 얼굴 인식 매칭 점수 (0~1) — MANUAL이면 null */
  checkInScore: number | null;
  checkOutScore: number | null;

  /** 강제 처리 사유 (MANUAL일 때 필수) */
  manualReason?: string;

  /**
   * 수동 등록 출처 — 누가 어디서 추가했는지.
   *  · 'HQ'      : 본사 관리자 (assignedSite='ALL' / role=OWNER 또는 본사 매니저)
   *  · 'SITE'    : 현장 담당자 (role=MANAGER, assignedSite=특정 현장)
   *  · 'FOREMAN' : 반장 (모바일 앱)
   *  자동 얼굴인식·GPS 출근은 이 값이 비어 있음.
   */
  manualEntryRole?: 'HQ' | 'SITE' | 'FOREMAN';
  /** 수동 등록한 사람의 이름 — 감사·툴팁 노출용 */
  manualEntryByName?: string;

  /** 자동 분류 결과 */
  status: DayResult;

  /** 분 단위 근로 시간 (퇴근 처리된 경우만) */
  workedMinutes: number;

  /** 산출된 공수 (0.5 단위) */
  gongsu: number;

  /** 일당 (그날 사용된 단가, 원) */
  dailyWage: number;

  /** 그날 지급 예정 임금 = dailyWage × gongsu */
  payAmount: number;

  /**
   * 수동 처리(공수 직접 입력) 임금 변동 이력 — 매 setGongsu 호출 시 push.
   * 첫 자동 산정 임금 → N 차 수동 보정 임금까지 모두 보존.
   * 화면에선 「200,000원 → 100,000원 → 150,000원」 형태로 가로 체인 표시.
   */
  manualPayHistory?: Array<{
    at: string;            // ISO 시각
    fromGongsu: number;    // 보정 전 공수
    fromPay: number;       // 보정 전 임금
    toGongsu: number;      // 보정 후 공수
    toPay: number;         // 보정 후 임금
    reason?: string;       // 보정 사유
    by?: string;           // 처리자 (옵션)
  }>;

  // ───── 지오펜싱 (출근 시점) ─────
  /** 출근 시점에 수집된 GPS 좌표 (없으면 미수집) */
  checkInLocation?: AttendanceLocation;
  /** 인증 결과 — INSIDE/OUTSIDE/NO_LOCATION/LOW_ACCURACY */
  geofenceResult?: GeofenceResult;
  /** 현장 좌표로부터의 거리 (m) — 좌표 수집된 경우만 */
  distanceFromSiteM?: number;
}

/** 월간 출퇴근 현황 요약 (현장 단위) */
export interface AttendanceMonth {
  year: number;
  month: number;
  siteId: string;

  /** 일자 헤더 — 'YYYY-MM-DD' 배열 (해당 달의 모든 날짜) */
  dates: string[];

  /** 팀원 행 — 팀원별 일자별 그리드 */
  rows: Array<{
    memberId: string;
    memberName: string;
    role: WorkerRole;
    dailyWage: number;
    /** date → record 매핑 (없는 날은 undefined → 결근/휴일) */
    daily: Record<string, AttendanceRecord | undefined>;
    /** 합계 */
    totalGongsu: number;
    totalDays: number;
    totalPay: number;
  }>;

  /** 전체 요약 */
  summary: {
    totalMembers: number;
    totalGongsu: number;
    totalPay: number;
    /** 인증 방법별 카운트 */
    faceCount: number;
    manualCount: number;
    /** 결근/지각/조퇴 카운트 */
    absentCount: number;
    lateCount: number;
    earlyCount: number;
  };
}

/** 오늘 현황 (현장의 현재 상태) */
export interface TodayAttendance {
  siteId: string;
  date: string;
  members: Array<{
    memberId: string;
    memberName: string;
    role: WorkerRole;
    status: AttendanceStatus;
    record: AttendanceRecord | null;
  }>;
  summary: {
    totalCount: number;
    beforeCount: number; // 출근 전
    workingCount: number; // 근무 중
    doneCount: number; // 퇴근 완료
  };
}

// ───────── 스마트폰 얼굴인식 출퇴근 (FACE) ─────────
//
// 향후 스마트폰 앱(작업자 본인 폰)에서 호출할 엔드포인트의 요청·응답 스키마.
// 본 mock 백엔드에는 시연용 스텁만 두고, 실 운영 시 백엔드(딥러닝 모델 + 저장소)에
// 동일한 contract 로 구현하면 화면 코드를 변경하지 않고 그대로 동작한다.
//
//  Mobile → Server 전송 항목:
//   1) 얼굴 임베딩 벡터 (서버 등록된 벡터와 매칭) 또는 매칭된 memberId
//   2) 매칭 점수 (0~1, 라이브니스 통과 후)
//   3) 라이브니스 검증 결과 (사진·영상 위변조 차단)
//   4) 디바이스 정보 (모델·OS·앱 버전·deviceId)
//   5) GPS 좌표 (지오펜스 검증)
//
//  Server → Client 응답:
//   · 정상: AttendanceRecord 1건 (checkInMethod='FACE')
//   · 거부: { reason, code } — 매칭 실패·반경 밖·라이브니스 실패 등

/** 라이브니스 검증 — 위변조(사진·영상·마스크) 차단 */
export type LivenessCheck = 'PASSED' | 'FAILED' | 'SKIPPED';

/** 디바이스 정보 — 작업자 본인 폰 */
export interface DeviceInfo {
  /** UUID/IDFV — 동일 기기 추적 (감사 로그 + 도용 방지) */
  deviceId: string;
  /** 'iOS 17.4', 'Android 14' 등 */
  os: string;
  /** 'iPhone 15 Pro', 'Galaxy S24' 등 */
  model?: string;
  /** 앱 버전 — '1.0.0' */
  appVersion: string;
}

/** 얼굴인식 출근 요청 — 스마트폰 앱 → 서버 */
export interface FaceCheckInRequest {
  /** 매칭된 워커 ID — 임베딩 매칭 후 서버가 반환한 ID 를 다시 보내거나, 서버측 DB 매칭 */
  memberId: string;
  siteId: string;
  /** 인증 시각 — 클라이언트 시각, 서버에서 30초 이내 검증 */
  capturedAt: string;
  /** 매칭 점수 (0~1) — 라이브니스 통과한 후의 임베딩 코사인 유사도 */
  matchScore: number;
  /** 라이브니스 검증 결과 */
  liveness: LivenessCheck;
  /** GPS — 지오펜스 검증용 */
  location: AttendanceLocation;
  /** 디바이스 정보 — 감사 로그 기록 */
  device: DeviceInfo;
  /**
   * 임베딩 벡터 — 백엔드가 매칭 안 됐다고 판단할 때 추가 비교용.
   * 정상 매칭 시엔 client 가 이미 매칭한 결과를 신뢰하므로 생략 가능.
   */
  embedding?: number[];
}

/** 얼굴인식 퇴근 요청 — 출근과 동일 구조 */
export type FaceCheckOutRequest = FaceCheckInRequest;

/** 얼굴인식 출퇴근 응답 */
export interface FaceCheckResponse {
  /** 생성·갱신된 출퇴근 기록 */
  record: AttendanceRecord;
  /** 처리 시각 (서버 시각) */
  processedAt: string;
  /** 안내 메시지 */
  message: string;
}

/** 얼굴인식 거부 응답 — 매칭 실패·반경 밖·라이브니스 실패 등 */
export interface FaceCheckRejection {
  code:
    | 'NO_MATCH'           // 매칭된 워커 없음 (등록 안 됨)
    | 'LOW_SCORE'          // 매칭 점수 임계값 미만
    | 'LIVENESS_FAILED'    // 사진·영상 위변조 의심
    | 'OUT_OF_GEOFENCE'    // 현장 반경 밖
    | 'STALE_TIMESTAMP'    // 클라이언트 시각이 서버와 30초 이상 차이
    | 'DEVICE_BLOCKED'     // 도용·차단된 디바이스
    | 'MEMBER_NOT_FOUND'   // memberId 가 DB에 없음
    | 'SITE_CLOSED'        // 그 날 출퇴근 마감됨
    ;
  message: string;
  /** 디버그/감사용 */
  detail?: Record<string, unknown>;
}

// ───────── 강제 처리 (MANUAL) ─────────

export interface ManualCheckRequest {
  memberId: string;
  /** CHECK_IN | CHECK_OUT */
  action: 'CHECK_IN' | 'CHECK_OUT';
  /** 시간 지정 (생략 시 지금) */
  at?: string;
  /** 5자 이상 — 감사 로그 */
  reason: string;
}

export interface ManualCheckResponse {
  recordId: string;
  processedAt: string;
}

// ───────── 공수 직접 입력 (관리자 수동 산정) ─────────
//
// 얼굴 인식 출/퇴근이 아예 없거나 불가능한 상황(현장 외부 작업·통신 두절·
// 휴일 보충 작업 등)에서 관리자가 일자별 공수를 직접 기록할 수 있게 한다.
//   - 출/퇴근 시각은 비울 수 있음 (공수만 기록)
//   - 5자 이상 사유 필수, 감사 로그에 'MANUAL_GONGSU' 타입으로 적힘
//   - 임금 = 일당 × 공수 자동 재계산

export interface SetGongsuRequest {
  memberId: string;
  /** 'YYYY-MM-DD' — 미래 일자는 거부 */
  date: string;
  /** 0 / 0.5 / 1.0 / 1.5 / 2.0 — 0이면 결근 처리 */
  gongsu: number;
  /** 5자 이상 */
  reason: string;
}

export interface SetGongsuResponse {
  recordId: string;
  date: string;
  gongsu: number;
  payAmount: number;
  processedAt: string;
}

// ───────── 일괄 퇴근 ─────────

export interface BulkCheckOutRequest {
  memberIds: string[];
  reason: string;
}

export interface BulkCheckOutResponse {
  processedAt: string;
  records: Array<{ memberId: string; recordId: string }>;
  failures: Array<{ memberId: string; reason: string }>;
}

// ───────── 감사 로그 ─────────

export interface AuditLogEntry {
  id: string;
  type:
    | 'MANUAL_CHECK_IN'
    | 'MANUAL_CHECK_OUT'
    | 'BULK_CHECK_OUT'
    | 'MANUAL_GONGSU';
  memberIds: string[];
  memberNames: string[];
  reason: string;
  performedBy: string;
  performedAt: string;
}

// ───────── 쿼리 ─────────

export interface AttendanceMonthQuery {
  siteId: string;
  yearMonth: string;
}

export interface AuditLogQuery {
  siteId: string;
  yearMonth?: string;
  limit?: number;
}

// ───────── 마감 (일/월) ─────────
//
// 일마감(DayClose):  현장에서 그날 출근 처리 끝나면 클릭 → 그 날짜 데이터 잠금
// 월마감(MonthClose): 한 달치 출퇴근 처리 끝나면 클릭 → 그 달 전체 잠금 + 임금 처리 가능
//
// 마감되면 manual check-in / 공수 입력 / 일괄 퇴근 등 데이터 변경 불가.
// 본사 사용자가 사유와 함께 재개봉(reopen) 가능.

export interface DayConfirmation {
  /** 확인 시각 ISO */
  at: string;
  byName: string;
}

export interface DayClose {
  siteId: string;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 호환용 — site 또는 HQ 확인 중 하나라도 있으면 'CLOSED' */
  status: 'OPEN' | 'CLOSED';
  // ───── 8단계 워크플로우 (신규) ─────
  /** ① 현장 오늘 출역 확인 */
  confirmedBySite?: DayConfirmation;
  /** ② 본사 오늘 출역 확인 */
  confirmedByHQ?: DayConfirmation;
  // ───── 호환용 (구) ─────
  closedAt?: string;
  closedByName?: string;
  reopenedAt?: string;
  reopenedByName?: string;
  reopenReason?: string;
}

/**
 * 출역(출퇴근) 단계 — 출퇴근 페이지에 노출
 *  OPEN          — 편집 가능
 *  SITE_CLOSED   — ③ 현장 월 공수 확정
 *  HQ_CONFIRMED  — ④ 본사 월 공수 확정 (이후 노임 편집 가능)
 */
export type AttCloseStage = 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED';

/**
 * 노임 단계 — 노임비 페이지에 노출
 *  attStage !== 'HQ_CONFIRMED' 동안 wage 액션은 잠금 (UI 차원)
 *
 *  OPEN          — 편집 가능 (출역이 HQ_CONFIRMED 인 경우)
 *  SITE_CLOSED   — ⑤ 현장 월 노임 확정
 *  HQ_CONFIRMED  — ⑥ 본사 월 노임 확정
 *  PAID          — ⑦ 본사 노임 지급 완료
 *  SETTLED       — ⑧ 정산 완료 (terminal)
 */
export type WageCloseStage = 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';

/**
 * 호환용 종합 stage — attStage/wageStage 에서 파생
 *
 *  OPEN          — attStage='OPEN'
 *  SITE_CLOSED   — attStage='SITE_CLOSED'
 *  HQ_CONFIRMED  — attStage='HQ_CONFIRMED', wageStage in [OPEN, SITE_CLOSED]
 *  HQ_CONFIRMED  — wageStage='HQ_CONFIRMED' (호환상 동일 라벨)
 *  PAID          — wageStage='PAID'
 *  SETTLED       — wageStage='SETTLED'
 */
export type CloseStage = 'OPEN' | 'SITE_CLOSED' | 'HQ_CONFIRMED' | 'PAID' | 'SETTLED';

/** 하도급 출력인원 확인 기록 */
export interface SubVerification {
  siteCompanyId: string;
  companyName: string;
  verifiedAt: string;
  verifiedByName: string;
}

export interface MonthClose {
  siteId: string;
  /** 'YYYY-MM' */
  yearMonth: string;
  /** 호환 — stage !== 'OPEN' 이면 'CLOSED' */
  status: 'OPEN' | 'CLOSED';
  /** 호환용 종합 stage — attStage / wageStage 에서 파생 */
  stage: CloseStage;

  // ───── 출역 (Phase A 신규) ─────
  attStage: AttCloseStage;
  /** ③ 현장 월 공수 확정 시각 */
  attSiteClosedAt?: string;
  attSiteClosedByName?: string;
  /** ④ 본사 월 공수 확정 시각 */
  attHqConfirmedAt?: string;
  attHqConfirmedByName?: string;
  /** 출역 되돌림 사유 */
  attReopenReason?: string;

  // ───── 노임 (Phase A 신규) ─────
  wageStage: WageCloseStage;
  /** ⑤ 현장 월 노임 확정 시각 */
  wageSiteClosedAt?: string;
  wageSiteClosedByName?: string;
  /** ⑥ 본사 월 노임 확정 시각 */
  wageHqConfirmedAt?: string;
  wageHqConfirmedByName?: string;
  /** ⑦ 본사 노임 지급 시각 */
  paidAt?: string;
  paidByName?: string;
  /** 마. 명세서 발행 시각 (지급완료 후) */
  payslipsIssuedAt?: string;
  payslipsIssuedByName?: string;
  /** ⑧ 정산 완료 시각 */
  settledAt?: string;
  settledByName?: string;
  /** 노임 되돌림 사유 */
  wageReopenReason?: string;

  // ───── 호환용 (구) ─────
  closedAt?: string;
  closedByName?: string;
  hqConfirmedAt?: string;
  hqConfirmedByName?: string;
  reopenedAt?: string;
  reopenedByName?: string;
  reopenReason?: string;

  /** 하도급별 출력인원 확인 — 원도급 화면에 체크칩으로 노출 */
  subVerifications?: SubVerification[];
}

export interface CloseStatusResponse {
  siteId: string;
  yearMonth: string;
  monthClose: MonthClose;
  /** 그 달의 일자별 마감 상태 (CLOSED 만 반환 — 나머지는 OPEN 으로 가정) */
  dayCloses: DayClose[];
}

export interface DayCloseRequest {
  siteId: string;
  date: string;
  /**
   *  CLOSE_BY_SITE  — ① 현장 오늘 출역 확인
   *  REOPEN_BY_SITE — 현장 확인 해제
   *  CLOSE_BY_HQ    — ② 본사 오늘 출역 확인
   *  REOPEN_BY_HQ   — 본사 확인 해제
   *  CLOSE/REOPEN   — (호환용) 현재 사용자 역할에 따라 SITE/HQ 로 라우팅
   */
  action:
    | 'CLOSE_BY_SITE' | 'REOPEN_BY_SITE'
    | 'CLOSE_BY_HQ'   | 'REOPEN_BY_HQ'
    | 'CLOSE'         | 'REOPEN';
  /** REOPEN 시 5자 이상 */
  reason?: string;
}

export interface MonthCloseRequest {
  siteId: string;
  yearMonth: string;
  /**
   * 출역 단계
   *  ATT_SITE_CLOSE     — ③ 현장: OPEN→SITE_CLOSED
   *  ATT_REOPEN         — 현장: SITE_CLOSED→OPEN (5자 사유)
   *  ATT_HQ_CONFIRM     — ④ 본사: SITE_CLOSED→HQ_CONFIRMED
   *  ATT_REVERT_CONFIRM — 본사: HQ_CONFIRMED→SITE_CLOSED (5자 사유)
   *
   * 노임 단계 (출역이 HQ_CONFIRMED 일 때만 가능)
   *  WAGE_SITE_CLOSE     — ⑤ 현장: OPEN→SITE_CLOSED
   *  WAGE_REOPEN         — 현장: SITE_CLOSED→OPEN (5자 사유)
   *  WAGE_HQ_CONFIRM     — ⑥ 본사: SITE_CLOSED→HQ_CONFIRMED
   *  WAGE_REVERT_CONFIRM — 본사: HQ_CONFIRMED→SITE_CLOSED (5자 사유)
   *
   * 지급/정산
   *  PAY      — ⑦ 본사: HQ_CONFIRMED→PAID
   *  UNPAY    — 본사: PAID→HQ_CONFIRMED (5자 사유)
   *  SETTLE   — ⑧ 본사: PAID→SETTLED (terminal)
   *  UNSETTLE — 본사: SETTLED 되돌림 (관리자만, 5자 사유)
   *
   * 호환용 (구)
   *  CLOSE          — ATT_SITE_CLOSE 로 라우팅
   *  REOPEN         — ATT_REOPEN 로 라우팅
   *  CONFIRM        — ATT_HQ_CONFIRM 로 라우팅
   *  REVERT_CONFIRM — ATT_REVERT_CONFIRM 로 라우팅
   */
  action:
    | 'ATT_SITE_CLOSE'    | 'ATT_REOPEN'
    | 'ATT_HQ_CONFIRM'    | 'ATT_REVERT_CONFIRM'
    | 'WAGE_SITE_CLOSE'   | 'WAGE_REOPEN' | 'WAGE_REVERT_SITE'
    | 'WAGE_HQ_CONFIRM'   | 'WAGE_REVERT_CONFIRM'
    | 'PAY' | 'UNPAY'
    | 'ISSUE_PAYSLIPS' | 'UNDO_PAYSLIPS'
    | 'SETTLE' | 'UNSETTLE'
    | 'CLOSE' | 'REOPEN' | 'CONFIRM' | 'REVERT_CONFIRM';
  reason?: string;
}

/** 하도급 출력인원 확인 요청 */
export interface SubVerifyRequest {
  siteId: string;
  yearMonth: string;
  siteCompanyId: string;
}
