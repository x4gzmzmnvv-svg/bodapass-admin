import { apiClient } from './client';
import type {
  CreateOnlineInviteRequest,
  CreateOnlineInviteResponse,
  DeleteMemberResponse,
  ListMembersQuery,
  ListMembersResponse,
  RegisterMemberRequest,
  RegisterMemberResponse,
  TeamMember,
  UpdateMemberRequest,
  UpdateMemberResponse,
  UploadImageResponse,
} from './team.types';

export const teamApi = {
  list: async (q: ListMembersQuery = {}): Promise<ListMembersResponse> => {
    const { data } = await apiClient.get<ListMembersResponse>('/team/members', {
      params: q,
    });
    return data;
  },

  get: async (id: string): Promise<TeamMember> => {
    const { data } = await apiClient.get<TeamMember>(`/team/members/${id}`);
    return data;
  },

  /** 대면/공무 등록 — 단일 요청 */
  register: async (req: RegisterMemberRequest): Promise<RegisterMemberResponse> => {
    const { data } = await apiClient.post<RegisterMemberResponse>('/team/members', req);
    return data;
  },

  /** 온라인(비대면) 초대 — SMS 발송 */
  invite: async (
    req: CreateOnlineInviteRequest,
  ): Promise<CreateOnlineInviteResponse> => {
    const { data } = await apiClient.post<CreateOnlineInviteResponse>(
      '/team/online-invite',
      req,
    );
    return data;
  },

  /** 팀원 정보 부분 수정 (직종/일당/배정 반장/현장 등) */
  update: async (
    id: string,
    req: UpdateMemberRequest,
  ): Promise<UpdateMemberResponse> => {
    const { data } = await apiClient.patch<UpdateMemberResponse>(
      `/team/members/${id}`,
      req,
    );
    return data;
  },

  remove: async (id: string): Promise<DeleteMemberResponse> => {
    const { data } = await apiClient.delete<DeleteMemberResponse>(`/team/members/${id}`);
    return data;
  },

  /** 사진 업로드 (multipart) */
  upload: async (
    kind: 'id' | 'face' | 'bank',
    file: File,
  ): Promise<UploadImageResponse> => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    const { data } = await apiClient.post<UploadImageResponse>(
      '/team/uploads',
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return data;
  },
};
