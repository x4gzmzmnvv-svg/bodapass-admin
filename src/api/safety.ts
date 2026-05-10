// FILE_VERSION 1777800001
import { apiClient } from './client';
import type {
  CreateCategoryRequest,
  ListAuditResponse,
  ListCategoriesResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  ResendUnreadRequest,
  ResendUnreadResponse,
  SafetyCategory,
  SafetyStats,
  SendMessageRequest,
  SendMessageResponse,
  TodayRecommendationsResponse,
  UpdateCategoryRequest,
} from './safety.types';

export const safetyApi = {
  // 카테고리
  async listCategories() {
    const { data } = await apiClient.get<ListCategoriesResponse>('/safety/categories');
    return data.categories;
  },
  async createCategory(req: CreateCategoryRequest) {
    const { data } = await apiClient.post<{ category: SafetyCategory }>('/safety/categories', req);
    return data.category;
  },
  async updateCategory(id: string, req: UpdateCategoryRequest) {
    const { data } = await apiClient.put<{ category: SafetyCategory }>(`/safety/categories/${id}`, req);
    return data.category;
  },
  async deleteCategory(id: string) {
    await apiClient.delete(`/safety/categories/${id}`);
  },

  // 메시지(발송 이력)
  async listMessages(filter: ListMessagesRequest = {}) {
    const { data } = await apiClient.get<ListMessagesResponse>('/safety/messages', { params: filter });
    return data;
  },
  async sendMessage(req: SendMessageRequest) {
    const { data } = await apiClient.post<SendMessageResponse>('/safety/messages', req);
    return data;
  },

  // 감사 로그
  async listAudit() {
    const { data } = await apiClient.get<ListAuditResponse>('/safety/audit');
    return data;
  },

  // 통계
  async stats() {
    const { data } = await apiClient.get<SafetyStats>('/safety/stats');
    return data;
  },

  // 미확인자 재발송
  async resendUnread(req: ResendUnreadRequest) {
    const { data } = await apiClient.post<ResendUnreadResponse>(
      `/safety/messages/${req.messageId}/resend`,
      { channels: req.channels },
    );
    return data;
  },

  // 오늘 추천 (공종 기반 자동)
  async todayRecommendations() {
    const { data } = await apiClient.get<TodayRecommendationsResponse>('/safety/recommendations');
    return data;
  },
};
