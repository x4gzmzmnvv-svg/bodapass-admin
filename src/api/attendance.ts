import { apiClient } from './client';
import type {
  AttendanceMonth,
  AttendanceMonthQuery,
  AuditLogEntry,
  AuditLogQuery,
  BulkCheckOutRequest,
  BulkCheckOutResponse,
  CloseStatusResponse,
  DayCloseRequest,
  FaceCheckInRequest,
  FaceCheckOutRequest,
  FaceCheckResponse,
  ManualCheckRequest,
  ManualCheckResponse,
  MonthCloseRequest,
  SetGongsuRequest,
  SetGongsuResponse,
  SubVerifyRequest,
  TodayAttendance,
} from './attendance.types';

export const attendanceApi = {
  month: async (q: AttendanceMonthQuery): Promise<AttendanceMonth> => {
    const { data } = await apiClient.get<AttendanceMonth>('/attendance/month', {
      params: q,
    });
    return data;
  },

  today: async (siteId: string): Promise<TodayAttendance> => {
    const { data } = await apiClient.get<TodayAttendance>('/attendance/today', {
      params: { siteId },
    });
    return data;
  },

  manualCheck: async (req: ManualCheckRequest): Promise<ManualCheckResponse> => {
    const { data } = await apiClient.post<ManualCheckResponse>(
      '/attendance/manual-check',
      req,
    );
    return data;
  },

  bulkCheckOut: async (req: BulkCheckOutRequest): Promise<BulkCheckOutResponse> => {
    const { data } = await apiClient.post<BulkCheckOutResponse>(
      '/attendance/bulk-check-out',
      req,
    );
    return data;
  },

  /**
   * 얼굴인식 출근 — 스마트폰 앱(작업자 본인 폰) 호출 진입점.
   * 본 admin 화면에선 사용 안 하지만, 향후 모바일 앱이 같은 contract 로 호출하도록 미리 정의.
   */
  faceCheckIn: async (req: FaceCheckInRequest): Promise<FaceCheckResponse> => {
    const { data } = await apiClient.post<FaceCheckResponse>(
      '/attendance/face-checkin',
      req,
    );
    return data;
  },

  /** 얼굴인식 퇴근 — 스마트폰 앱 호출 진입점 */
  faceCheckOut: async (req: FaceCheckOutRequest): Promise<FaceCheckResponse> => {
    const { data } = await apiClient.post<FaceCheckResponse>(
      '/attendance/face-checkout',
      req,
    );
    return data;
  },

  /** 관리자가 일자별 공수를 직접 입력 (얼굴 인식 외 보충) */
  setGongsu: async (req: SetGongsuRequest): Promise<SetGongsuResponse> => {
    const { data } = await apiClient.post<SetGongsuResponse>(
      '/attendance/set-gongsu',
      req,
    );
    return data;
  },

  /** 여러 일자를 한 번에 같은 공수/사유로 입력 (드래그 다중 선택) */
  bulkSetGongsu: async (req: {
    memberId: string;
    dates: string[];
    gongsu: number;
    reason: string;
  }): Promise<{
    memberId: string;
    datesProcessed: string[];
    savedCount: number;
    gongsu: number;
  }> => {
    const { data } = await apiClient.post(
      '/attendance/bulk-set-gongsu',
      req,
    );
    return data;
  },

  auditLog: async (q: AuditLogQuery): Promise<{ entries: AuditLogEntry[] }> => {
    const { data } = await apiClient.get<{ entries: AuditLogEntry[] }>(
      '/attendance/audit-log',
      { params: q },
    );
    return data;
  },

  /** 일/월 마감 상태 조회 */
  closeStatus: async (siteId: string, yearMonth: string): Promise<CloseStatusResponse> => {
    const { data } = await apiClient.get<CloseStatusResponse>(
      '/attendance/close-status',
      { params: { siteId, yearMonth } },
    );
    return data;
  },

  /** 일자 마감 / 재개봉 */
  dayClose: async (req: DayCloseRequest): Promise<{ ok: true }> => {
    const { data } = await apiClient.post<{ ok: true }>(
      '/attendance/day-close',
      req,
    );
    return data;
  },

  /** 월 마감 / 재개봉 / HQ 확인 / HQ 정산 — 액션 1개 엔드포인트 */
  monthClose: async (req: MonthCloseRequest): Promise<{ ok: true }> => {
    const { data } = await apiClient.post<{ ok: true }>(
      '/attendance/month-close',
      req,
    );
    return data;
  },

  /** 하도급 출력인원 확인 — 원도급 화면에 체크칩으로 노출됨 */
  subVerify: async (req: SubVerifyRequest): Promise<{ ok: true }> => {
    const { data } = await apiClient.post<{ ok: true }>(
      '/attendance/month-sub-verify',
      req,
    );
    return data;
  },
};
