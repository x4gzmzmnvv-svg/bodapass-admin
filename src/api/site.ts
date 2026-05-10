import { apiClient } from './client';
import type {
  CreateForemenRequest,
  CreateForemenResponse,
  CreateSiteRequest,
  DashboardSummary,
  ForemanMetrics,
  ForemanSite,
  ListForemanSitesResponse,
  ListForemenResponse,
  ListSitesResponse,
  Site,
  SiteCreateResponse,
} from './site.types';

/** 현장·반장·대시보드 API */
export const siteApi = {
  /** 대시보드 요약 — 현재 선택된 현장의 KPI + 반장 목록 */
  dashboard: async (siteId?: string): Promise<DashboardSummary> => {
    const { data } = await apiClient.get<DashboardSummary>('/dashboard/summary', {
      params: siteId ? { siteId } : undefined,
    });
    return data;
  },

  /** 현장 목록 */
  listSites: async (): Promise<ListSitesResponse> => {
    const { data } = await apiClient.get<ListSitesResponse>('/sites');
    return data;
  },

  getSite: async (id: string): Promise<Site> => {
    const { data } = await apiClient.get<Site>(`/sites/${id}`);
    return data;
  },

  createSite: async (req: CreateSiteRequest): Promise<SiteCreateResponse> => {
    const { data } = await apiClient.post<SiteCreateResponse>('/sites', req);
    return data;
  },

  /** 현장 정보 부분 갱신 (예: 준공 처리, 도급금액 수정) */
  updateSite: async (
    id: string,
    patch: Partial<Site>,
  ): Promise<{ site: Site; message: string }> => {
    const { data } = await apiClient.patch<{ site: Site; message: string }>(
      `/sites/${id}`,
      patch,
    );
    return data;
  },

  /** 반장 목록 (전체 또는 특정 현장) */
  listForemen: async (siteId?: string): Promise<ListForemenResponse> => {
    const { data } = await apiClient.get<ListForemenResponse>('/foremen', {
      params: siteId ? { siteId } : undefined,
    });
    return data;
  },

  /** 반장 일괄 등록 + SMS/카카오톡 발송 */
  createForemen: async (req: CreateForemenRequest): Promise<CreateForemenResponse> => {
    const { data } = await apiClient.post<CreateForemenResponse>('/foremen/batch', req);
    return data;
  },

  /** 반장 삭제 (가입 대기 「초대 취소」 또는 활성 반장 제거) */
  deleteForeman: async (id: string): Promise<{ deleted: boolean; foremanId: string }> => {
    const { data } = await apiClient.delete<{ deleted: boolean; foremanId: string }>(
      `/foremen/${id}`,
    );
    return data;
  },

  /** ForemanSite — 반장 × 현장 다대다 배정 목록 */
  listForemanSites: async (params?: {
    foremanId?: string;
    siteId?: string;
    includeEnded?: boolean;
  }): Promise<ListForemanSitesResponse> => {
    const { data } = await apiClient.get<ListForemanSitesResponse>('/foreman-sites', {
      params,
    });
    return data;
  },

  /** ForemanSite — 신규 배정 발급 (반장 스마트폰으로 계약서 전송) */
  createForemanSite: async (
    body: Partial<ForemanSite>,
  ): Promise<{ foremanSite: ForemanSite }> => {
    const { data } = await apiClient.post<{ foremanSite: ForemanSite }>(
      '/foreman-sites',
      body,
    );
    return data;
  },

  /** ForemanSite — 부분 갱신 (승인/주담당 토글/종료 처리) */
  updateForemanSite: async (
    id: string,
    patch: Partial<ForemanSite>,
  ): Promise<{ foremanSite: ForemanSite }> => {
    const { data } = await apiClient.patch<{ foremanSite: ForemanSite }>(
      `/foreman-sites/${id}`,
      patch,
    );
    return data;
  },

  /** ForemanSite — 삭제 (시연 모드 — 운영에선 status=TERMINATED 권장) */
  deleteForemanSite: async (id: string): Promise<{ deleted: boolean; id: string }> => {
    const { data } = await apiClient.delete<{ deleted: boolean; id: string }>(
      `/foreman-sites/${id}`,
    );
    return data;
  },

  /** 반장 누적 KPI — 얼굴인식률·수동처리율·GPS 정상률 */
  listForemanMetrics: async (
    foremanId?: string,
  ): Promise<{ metrics: ForemanMetrics[] }> => {
    const { data } = await apiClient.get<{ metrics: ForemanMetrics[] }>(
      '/foreman-metrics',
      { params: foremanId ? { foremanId } : undefined },
    );
    return data;
  },
};
