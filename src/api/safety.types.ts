/**
 * 안전관리(Safety) 도메인 타입
 *
 *  - SafetyCategory : 안전 알림 카테고리 (12종 표준 + 사용자 정의)
 *  - SafetyMessage  : 발송 이력 (발송함/사고 대응 출력의 단일 진실원)
 *  - SafetyAudit    : 감사 로그 (불변 — 사고 발생 시 추적용)
 *
 *  정책
 *   1) 발송된 SafetyMessage 는 영구 보관 (수정/삭제 불가).
 *   2) 카테고리(표준 12종)는 수정/삭제 불가 — 사용자 정의 항목만 가능.
 *   3) SafetyAudit 는 추가만 가능, 수정·삭제 불가 (블록체인 스타일 append-only).
 *   4) 사고 발생 시 「특정 기간·현장」 으로 필터링해 PDF/Excel 출력 가능.
 */

/** 메시지 심각도 — 시각적 강조 + 차후 발송 채널 우선순위 결정 */
export type SafetySeverity = 'NORMAL' | 'CAUTION' | 'CRITICAL';

/** 발송 채널 */
export type SafetyChannel = 'SMS' | 'APP';

/** 수신자 유형 */
export type SafetyRecipientKind = 'FOREMAN' | 'WORKER' | 'GROUP_SITE' | 'GROUP_ALL';

/** 발송 결과 */
export type SafetyMessageStatus = 'SENT' | 'PARTIAL' | 'FAILED';

// ───────── 카테고리 ─────────

export interface SafetyCategory {
  id: string;
  /** 이모지 또는 short label */
  icon: string;
  /** 제목 (사이드바·카드에서 보임) */
  title: string;
  /** 본문 기본값 (사용자가 발송 시 자유 편집 가능) */
  defaultMsg: string;
  severity: SafetySeverity;
  /** 12종 표준은 true — 수정/삭제 불가 */
  isStandard: boolean;
  /** 표시 순서 — 작을수록 위에 */
  sortOrder: number;
  createdAt: string;
  /** 사용자 정의면 등록한 사람 */
  createdBy?: { userId: string; name: string };
  /** 적용 공종/직종 — 오늘 출근자 직종 분포와 매칭해 자동 추천에 사용
   *  TeamMember.role 의 부분 문자열로 매칭 (예: '철근' 은 '철근공'·'철근반장' 모두 매칭) */
  appliedRoles?: string[];
}

// ───────── 수신자 ─────────

export interface SafetyRecipient {
  kind: SafetyRecipientKind;
  /** 개인 (반장/팀원) ID 또는 그룹 키 (siteId/all) */
  id: string;
  /** 발송 시점 스냅샷 — 사람이 떠나도 이력 보존 */
  name: string;
  phone?: string;
  /** 어느 현장에 발송했는지 (조회 필터용) */
  siteId?: string;
  siteName?: string;
}

// ───────── 수신 대상 필터 (출퇴근 연동) ─────────

export type SafetyAudienceFilter =
  | 'ALL_REGISTERED'  // 등록된 모든 팀원 (기본)
  | 'WORKING_TODAY'   // 오늘 출근한 팀원만
  | 'BY_FOREMAN'      // 특정 반장이 관리하는 팀원
  | 'BY_ROLE'         // 특정 직종만
  | 'CUSTOM';         // 직접 선택

// ───────── 확인 상태 (read-receipt) ─────────

export interface SafetyReadReceipt {
  recipientId: string;
  recipientName: string;
  /** 확인 시각 (ISO) — 미확인이면 undefined */
  readAt?: string;
  /** 확인 경로 — 'APP'(반장 폰 앱 내), 'REPLY'(SMS 회신), 'FOREMAN'(반장이 대신 확인) */
  via?: 'APP' | 'REPLY' | 'FOREMAN';
}

// ───────── 재발송 시도 ─────────

export interface SafetyDeliveryAttempt {
  /** 시도 번호 — 1 = 최초 발송, 2/3 = 재발송 */
  attempt: number;
  /** 시도 시각 */
  at: string;
  /** 그 시점의 미확인 인원 수 */
  unreadCount: number;
  /** 그 시점의 수신자 수 */
  targetCount: number;
  /** 누가 트리거했는지 (system = 자동 스케줄, 사람 = 수동) */
  triggeredBy: { userId: string; name: string } | 'system';
}

// ───────── 발송 이력 ─────────

export interface SafetyMessage {
  id: string;
  /** 표준/사용자 정의 카테고리 ID, 자유 입력이면 null */
  categoryId: string | null;
  /** 발송 시점의 카테고리 제목 (스냅샷) — 카테고리 이름이 바뀌어도 이력은 그대로 */
  categoryTitle: string;
  /** 발송 본문 — 사용자가 편집한 최종 텍스트 */
  message: string;
  severity: SafetySeverity;
  recipients: SafetyRecipient[];
  channels: SafetyChannel[];
  /** 수신 대상을 어떻게 추렸는지 (감사 자료) */
  audienceFilter: SafetyAudienceFilter;
  /** 누가 보냈는지 — 감사 추적용 */
  sentBy: { userId: string; name: string };
  sentAt: string;
  /** 발송 결과 */
  status: SafetyMessageStatus;
  /** 발송 실패한 수신자 (이름·사유) */
  failures?: Array<{ recipientId: string; recipientName: string; reason: string }>;
  /** 수신자별 확인 상태 — 최초 발송 시 모두 unread, 시간이 지나며 일부 read */
  readReceipts: SafetyReadReceipt[];
  /** 발송·재발송 시도 기록 (1차 = 최초, 2~3차 = 미확인자 재발송) */
  deliveryAttempts: SafetyDeliveryAttempt[];
  /** 메모 (사고 대응 시 추가 메모 — 선택) */
  note?: string;
}

// ───────── 감사 로그 ─────────

export type SafetyAuditType =
  | 'SEND_MESSAGE'
  | 'RESEND_UNREAD'    // 미확인자 재발송
  | 'CREATE_CATEGORY'
  | 'UPDATE_CATEGORY'
  | 'DELETE_CATEGORY'
  | 'EXPORT_LOG';
export interface SafetyAudit {
  id: string;
  type: SafetyAuditType;
  performedBy: { userId: string; name: string };
  performedAt: string;
  targetId: string;
  summary: string;
  payload?: Record<string, unknown>;
}

// ───────── API 요청/응답 ─────────

export interface ListCategoriesResponse {
  categories: SafetyCategory[];
}

export interface CreateCategoryRequest {
  icon: string;
  title: string;
  defaultMsg: string;
  severity: SafetySeverity;
  appliedRoles?: string[];
}

export interface UpdateCategoryRequest {
  icon?: string;
  title?: string;
  defaultMsg?: string;
  severity?: SafetySeverity;
  appliedRoles?: string[];
}

export interface ListMessagesRequest {
  fromDate?: string;
  toDate?: string;
  siteId?: string;
  categoryId?: string;
  q?: string;
}

export interface ListMessagesResponse {
  messages: SafetyMessage[];
  total: number;
}

export interface SendMessageRequest {
  categoryId: string | null;
  categoryTitle: string;
  message: string;
  severity: SafetySeverity;
  recipients?: SafetyRecipient[];
  audienceFilter: SafetyAudienceFilter;
  audienceArg?: string;
  siteId?: string;
  channels: SafetyChannel[];
  note?: string;
}

export interface SendMessageResponse {
  message: SafetyMessage;
  audit: SafetyAudit;
}

export interface ResendUnreadRequest {
  messageId: string;
  channels?: SafetyChannel[];
}

export interface ResendUnreadResponse {
  message: SafetyMessage;
  audit: SafetyAudit;
  resentCount: number;
}

export interface ListAuditResponse {
  entries: SafetyAudit[];
  total: number;
}

export interface SafetyStats {
  monthCount: number;
  totalCount: number;
  byCategory: Array<{ categoryId: string | null; categoryTitle: string; count: number }>;
  byDate: Array<{ date: string; count: number }>;
  byChannel: Array<{ channel: SafetyChannel; count: number }>;
}

export interface TodayRecommendation {
  category: SafetyCategory;
  matchedWorkers: number;
  matchedRoles: string[];
}

export interface TodayRecommendationsResponse {
  workingToday: number;
  rolesDistribution: Array<{ role: string; count: number }>;
  recommendations: TodayRecommendation[];
  weather?: { condition: 'NORMAL' | 'HEAT' | 'COLD' | 'RAIN' | 'WIND'; label: string };
}
