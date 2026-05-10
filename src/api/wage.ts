import { apiClient } from './client';
import type {
  PayoutDispatchResponse,
  SeveranceMonthSummary,
  SeveranceQuery,
  WageMonthSummary,
  WageQuery,
} from './wage.types';

export const wageApi = {
  monthSummary: async (q: WageQuery): Promise<WageMonthSummary> => {
    const { data } = await apiClient.get<WageMonthSummary>('/wage/month', { params: q });
    return data;
  },

  severance: async (q: SeveranceQuery): Promise<SeveranceMonthSummary> => {
    const { data } = await apiClient.get<SeveranceMonthSummary>('/severance/month', {
      params: q,
    });
    return data;
  },

  /** Excel 다운로드 트리거 — 데모에서는 응답만 반환 */
  exportExcel: async (q: WageQuery): Promise<PayoutDispatchResponse> => {
    const { data } = await apiClient.post<PayoutDispatchResponse>('/wage/export', q);
    return data;
  },

  /** 카카오톡/SMS 발송 */
  dispatch: async (
    q: WageQuery & { channel: 'KAKAO' | 'SMS' },
  ): Promise<PayoutDispatchResponse> => {
    const { data } = await apiClient.post<PayoutDispatchResponse>('/wage/dispatch', q);
    return data;
  },
};
