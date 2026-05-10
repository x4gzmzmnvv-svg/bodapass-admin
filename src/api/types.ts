/**
 * 관리자 웹 공통 DTO 타입.
 * 앱(/ilgampack/src/api/types.ts)과 호환되는 모양을 유지하되,
 * 관리자 전용 필드(권한 / 회사 등)를 추가합니다.
 */

// ───────── 공통 ─────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  errorCode?: string;
}

// ───────── 인증 ─────────

export type AdminRole = 'OWNER' | 'MANAGER' | 'STAFF';

export interface AdminUser {
  userId: string;
  loginId: string;
  name: string;
  email?: string;
  phoneNumber?: string;
  role: AdminRole;
  /** 소속 회사 (와이어프레임의 "회사 최초 등록" 흐름 대응) */
  companyId: string;
  companyName: string;
  /** 마지막 로그인 시각 (ISO) */
  lastLoginAt?: string;
  /**
   * 단일 현장에만 배정된 사용자(현장담당자)일 때 그 siteId.
   *  - 'ALL' 이거나 undefined → 본사 사용자 (전 현장 가시)
   *  - 특정 siteId → 현장담당자 — 자기 현장만 가시
   */
  assignedSiteId?: 'ALL' | string;
}

export interface LoginRequest {
  loginId: string;
  password: string;
  /** 자동 로그인 (관리자 PC 환경 — 30일) */
  remember?: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AdminUser;
}

// ───────── 회원가입 (회사 최초 등록) ─────────

/** 약관 종류 — 필수/선택 분리 */
export type TermKind =
  | 'TERMS_OF_SERVICE' // 회원가입약관 (필수)
  | 'PRIVACY_POLICY' // 개인정보처리방침 (필수)
  | 'PRIVACY_THIRD_PARTY' // 제3자 제공 (선택)
  | 'MARKETING'; // 마케팅 정보 수신 (선택)

export interface TermAgreement {
  kind: TermKind;
  agreed: boolean;
  /** 동의 시각 (ISO) */
  agreedAt?: string;
}

/** 사용자(개인) 정보 */
export interface SignupUserInfo {
  loginId: string;
  password: string;
  name: string;
  birthDate: string; // 'YYYY-MM-DD'
  phoneNumber: string; // '010-XXXX-XXXX'
  email?: string;
  certificateFile?: File;
}

/** 회사 정보 */
export interface SignupCompanyInfo {
  companyName: string;
  businessRegistration?: string;
  businessNumber?: string; // 사업자등록번호 (통합명칭)
  representative?: string; // 대표자명
  representativePhone?: string; // 대표 전화번호
  address?: string; // 회사 주소
  addressDetail?: string; // 상세주소
  companyPhone?: string; // 회사 전화번호
  companyEmail?: string; // 회사 이메일
  managerName?: string; // 담당자명
  managerPhone?: string; // 담당자 전화번호
  isConstructionCompany?: boolean; // 건설사 여부
}

/** 회원가입 Step 1 요청 */
export interface SignupStep1Request {
  terms: TermAgreement[];
}

/** 회원가입 Step 2 요청 */
export interface SignupStep2Request {
  userInfo: SignupUserInfo;
  companyInfo: SignupCompanyInfo;
}

/** 회원가입 Step 3 요청 (최종 제출) — SignupStep3.tsx에서 사용하는 구조 */
export interface SignupStep3Request {
  agreements: TermAgreement[];
  user: SignupUserInfo;
  company: SignupCompanyInfo;
  certificateId?: string;
}

/** 회원가입 응답 */
export interface SignupResponse {
  userId: string;
  companyId: string;
  loginId: string;
  createdAt: string; // ISO timestamp
  accessToken?: string;
  refreshToken?: string;
}

/** 아이디 중복 검사 */
export interface CheckLoginIdRequest {
  loginId: string;
}

export interface CheckLoginIdResponse {
  loginId: string;
  available: boolean;
  reason?: string;
}

/** 인증서 업로드 응답 */
export interface CertificateUploadResponse {
  certificatePath: string;
  certificateId?: string; // 인증서 ID
  cn: string; // Common Name (개인/회사명)
}
