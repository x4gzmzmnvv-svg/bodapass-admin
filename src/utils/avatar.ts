/**
 * 아바타 placeholder 헬퍼
 *  - 추후 얼굴 인식 사진으로 대체될 자리
 *  - 현재는 pravatar.cc (CC0 라이선스 인물 사진) 사용
 *  - 같은 id 는 항상 같은 사진을 반환
 */

const AVATAR_BASE = 'https://i.pravatar.cc';

/**
 * @param id  반장/팀원 식별자 (id, phone, name 등 deterministic 키)
 * @param size 사이즈 (px). 기본 80
 */
export function getAvatarUrl(id: string, size = 80): string {
  const seed = encodeURIComponent(id || 'default');
  return `${AVATAR_BASE}/${size}?u=${seed}`;
}
