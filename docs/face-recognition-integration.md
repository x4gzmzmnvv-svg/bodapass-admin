# 스마트폰 얼굴인식 출퇴근 — 연동 가이드

**대상 시스템:** 보다패스 작업자용 모바일 앱 (작업자 본인 폰에 설치)
**연동 시점:** 본 admin 웹과 Mock 백엔드는 이미 동일 contract 로 동작.
실서버 도입 시 동일 endpoint 만 구현하면 화면 코드 변경 없이 즉시 작동.

---

## 1. 등록 단계 (1회)

작업자가 시스템에 가입할 때 실행하는 사전 작업.

```
┌────────────────┐     ┌──────────────────┐     ┌────────────┐
│ 모바일 앱       │ →  │ 얼굴 임베딩 추출 │ →  │ 서버 저장  │
│ (선명한 정면 │     │ (on-device 또는 │     │ Worker.    │
│  사진 1장)     │     │  서버 측)        │     │ faceVector │
└────────────────┘     └──────────────────┘     └────────────┘
```

- 얼굴 임베딩(512차원 float vector)은 서버에 저장.
- `Worker.faceVerified = true` 로 변경되면 Tier 1 / Tier 2 자격 부여.
- 사진 자체는 서버에 보관 X (개인정보보호 차원, 임베딩만).

---

## 2. 출근 흐름 (매일)

작업자가 현장 도착 → 앱 실행 → 본인 얼굴 촬영 → 출근 확정.

```
모바일 앱:
  1. 카메라 ON + 라이브니스 검증 (눈깜빡임/머리회전)
  2. 추출된 임베딩으로 on-device 매칭 (서버 등록 벡터와 코사인 유사도)
  3. 매칭 성공 + GPS 획득 + 서버 시각 동기화
  4. POST /attendance/face-checkin 전송 ↓

서버:
  1. memberId 검증 — 등록된 워커?
  2. liveness === 'PASSED' 확인
  3. matchScore >= 0.85 확인
  4. 시각 ±30초 동기화 검증
  5. GPS 가 site.geofence 반경 내인지 확인
  6. 그 날 출퇴근 마감 안 됐는지 확인
  7. AttendanceRecord 생성 (checkInMethod='FACE')
  8. AuditLog 'MANUAL_CHECK_IN' 기록 (시스템 자동)
  9. 응답 200 + record + 「인식률 N%」 메시지
```

### 요청 스키마 (`FaceCheckInRequest`)

```typescript
POST /attendance/face-checkin
Content-Type: application/json
Authorization: Bearer <user-token>

{
  "memberId": "M-001234",
  "siteId":   "S-2026-1043",
  "capturedAt": "2026-05-05T07:25:00.123Z",
  "matchScore": 0.97,
  "liveness": "PASSED",         // 'PASSED' | 'FAILED' | 'SKIPPED'
  "location": {
    "lat": 37.4979,
    "lng": 127.0276,
    "accuracy": 8.5,            // m
    "capturedAt": "2026-05-05T07:24:55.000Z"
  },
  "device": {
    "deviceId": "uuid-...",
    "os": "iOS 17.4",
    "model": "iPhone 15 Pro",
    "appVersion": "1.0.0"
  },
  "embedding": [/* 512 floats — 옵션 */]
}
```

### 응답 (정상)

```typescript
HTTP/1.1 200 OK

{
  "record": {
    "id": "R-M-001234-2026-05-05",
    "memberId": "M-001234",
    "memberName": "김철수",
    "checkInAt": "2026-05-05T07:25:00.123Z",
    "checkInMethod": "FACE",
    "checkInScore": 0.97,
    "checkInLocation": { ... },
    "geofenceResult": "INSIDE",
    "distanceFromSiteM": 12,
    ...
  },
  "processedAt": "2026-05-05T07:25:01.456Z",
  "message": "얼굴인식 출근 완료 (인식률 97%)"
}
```

### 응답 (거부)

```typescript
HTTP/1.1 422 Unprocessable Entity

{
  "code": "OUT_OF_GEOFENCE",
  "message": "현장 반경 밖 — 거리 350m",
  "detail": { "distance": 350, "radius": 100 }
}
```

거부 코드:
- `NO_MATCH` — 임베딩 매칭 실패
- `LOW_SCORE` — 점수 < 임계값 (0.85)
- `LIVENESS_FAILED` — 사진·영상 위변조 의심
- `OUT_OF_GEOFENCE` — 현장 반경 밖
- `STALE_TIMESTAMP` — 시각 ±30초 초과
- `DEVICE_BLOCKED` — 차단된 디바이스
- `MEMBER_NOT_FOUND` — 등록 안 된 워커
- `SITE_CLOSED` — 그 날 출퇴근 마감

---

## 3. 퇴근 흐름

`POST /attendance/face-checkout` — 출근과 동일 스키마.

서버 처리:
1. 출근 기록 존재 확인 (`record.checkInAt` 있어야 함)
2. 검증 5종 (출근과 동일)
3. 공수 자동 계산 — `calcGongsu(checkInAt, checkOutAt)`
4. `record.payAmount = dailyWage × gongsu`
5. AuditLog 기록

---

## 4. 화면 노출

본 admin 화면(AttendancePage)은 이미 모든 표시 로직을 갖추고 있음.
모바일 얼굴인식이 도입되면 **별도 코드 변경 없이** 같은 캘린더에 자동 노출.

| 화면 위치 | 표시 내용 |
|---|---|
| 일자별 출력 시간 칩 | `07:25` 파란 칩 (FACE) — hover 툴팁 「인식률 97% · 07:25」 |
| 캘린더 셀 | `1.0` 공수 + 얼굴 매칭 점수가 95% 미만이면 회색 강조 |
| 수동 공수 처리 모달 | 「✓ 자동 얼굴인식 으로 기록된 출역입니다. 보정하시겠습니까?」 (파란 info 박스) |
| 출/퇴근 라벨 | 「인식률 N%」 (출근), 「인식률 N%」 또는 18시 이후 + score null 이면 「자동퇴근」 (퇴근) |
| 지오펜스 뱃지 | `OUTSIDE` / `LOW_ACCURACY` / `NO_LOCATION` 시 ⚠ / 📍 / ❓ 아이콘 |

---

## 5. 보안·감사

### 5.1 도용 방지

| 위협 | 차단 메커니즘 |
|---|---|
| 사진 들이대기 | 라이브니스 — 눈깜빡임·고개돌림 (`liveness === 'PASSED'` 필수) |
| 다른 사람 폰 사용 | `deviceId` 추적 + 매월 1회 디바이스 등록 검증 |
| 시각 조작 | 클라이언트 시각 ±30초 검증 (`STALE_TIMESTAMP`) |
| 현장 밖 인증 | GPS 지오펜스 검증 (`OUT_OF_GEOFENCE`) |
| 임베딩 도용 | 매 인증 시 라이브니스 통과 후의 임베딩만 인정 (저장 X) |

### 5.2 감사 로그

모든 face-checkin/out 호출은 자동으로 `AuditLog` 에 기록됨:

```typescript
{
  type: 'MANUAL_CHECK_IN',  // 코드는 manual 이지만 reason 에 [얼굴인식 출근] prefix
  memberIds: ['M-001234'],
  memberNames: ['김철수'],
  reason: '[얼굴인식 출근] iPhone 15 Pro · 점수 97%',
  performedBy: '시스템(FACE)',
  performedAt: '2026-05-05T07:25:01.456Z'
}
```

운영자는 출퇴근 페이지의 「감사 로그」 패널에서 시스템 처리·수동 처리·도용 시도를 한눈에 확인 가능.

---

## 6. 향후 확장 포인트

- **임베딩 매칭은 온디바이스로** — 서버에 임베딩 저장은 1회 등록 시만, 매 인증 시엔 클라이언트가 자체 매칭 후 결과만 전송 (개인정보보호 강화)
- **다인 매칭 거부** — 1인 1폰 강제, 같은 deviceId 가 여러 memberId 와 매칭되면 차단
- **터널·실내 GPS 약함** — `LOW_ACCURACY` 일 때 비콘·WiFi SSID 보조 검증 옵션
- **퇴근 자동 처리** — 18:00 + 출근 후 8시간 경과 시 시스템이 자동 `MANUAL` 퇴근 등록 (현재 mock 시드에서 이미 시뮬레이션 중)
