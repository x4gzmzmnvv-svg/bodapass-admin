# 「개인별 보기」 탭 — 보관 코드 (Deprecation Record)

- **태그**: `개인별 보기`
- **제거 날짜**: 2026-05-08
- **삭제 예정일**: 2026-06-07 (제거 후 30일 — 이 날짜까지 복원 요청이 없으면 아래 코드를 영구 삭제)
- **사용자 결정**: 「개인별 보기는 삭제 해줘. 언젠가는 불러 올 수 있으니까. "개인별 보기"로 등록하고 별도로 저장해놔. 따로 불러오기 안하면 30일 있다가 코드를 삭제 해줘.」
- **복원 방법**: 이 문서 하단의 「복원 절차」 참조

---

## 무엇이 어떻게 빠졌는가

### 1. UI 토글 버튼 (제거됨)
파일: `src/pages/AttendancePage.tsx`
원본 위치: `<div className="auth-view-toggle">` 안

```tsx
<button type="button"
  className={'auth-view-btn' + (dailyView === 'member' ? ' is-active' : '')}
  onClick={() => setDailyView('member')}>개인별 보기</button>
```

### 2. 본 화면 코드 (제거되지 않음, 단지 도달 불가)
파일: `src/pages/AttendancePage.tsx`
- `dailyView` state type: `'site' | 'calendar' | 'member'` — `'member'` 옵션 그대로 유지 (TS 영향 없음)
- 조건부 렌더 블록: `{(attTab !== 'daily' || dailyView === 'member') && ( ... )}`
  - 라인 위치: `// 일일확정 «개인별 보기» — dailyView === 'member' 일 때만 노출.` 주석으로 시작
  - 사용자가 토글 버튼을 통해 `dailyView`를 `'member'`로 설정할 수 없으므로, 이 블록은 도달 불가 (dead path)
  - 단, 이 블록은 `attTab !== 'daily'` (즉 인증관리 탭) 에서도 렌더되므로 인증관리 화면의 보조 정보로는 계속 작동
- 관련 보조 함수·상태: 그대로 유지 (다른 화면에서 활용)

### 3. CSS
- `.auth-view-btn` 본문 — 그대로 유지 (오늘 확정·월간 내역 토글에서 사용 중)
- 「개인별 보기」 전용 CSS 없음

---

## 복원 절차

1. 이 파일을 참고하여 `src/pages/AttendancePage.tsx` 의 `<div className="auth-view-toggle">` 영역에 다음 버튼 한 개를 다시 추가:

```tsx
<button type="button"
  className={'auth-view-btn' + (dailyView === 'member' ? ' is-active' : '')}
  onClick={() => setDailyView('member')}>개인별 보기</button>
```

2. (이미 유지 중인) `dailyView` state, 조건부 렌더 블록은 손댈 필요 없음 — 토글 버튼만 부활시키면 즉시 작동.

3. 이 문서를 삭제 또는 「복원 완료 + 날짜」로 갱신.

---

## 30일 후 영구 삭제 절차 (2026-06-07 이후)

복원되지 않으면 아래 항목을 모두 제거:

1. `src/pages/AttendancePage.tsx`:
   - `dailyView` state 타입에서 `'member'` 옵션 제거 → `'site' | 'calendar'`
   - 조건문 `attTab !== 'daily' || dailyView === 'member'` → `attTab !== 'daily'` 로 단순화
   - 본 화면 블록 안에 있는 「개인별 보기」 전용 보조 코드 (필요 시 식별 후 삭제)
2. 이 deprecated 마크다운 파일 자체 삭제
3. 변경 커밋: `chore: remove deprecated 개인별 보기 tab (30 days expired)`
