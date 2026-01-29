# Reminder Bot

Slack에서 정산 알림 및 그룹웨어 마감을 자동화하는 봇입니다.

---

## 주요 기능

### 정산 알림 (Queenit, Paldogam)
- **자동 정산 알림** - 정산일에 Slack 알림 발송
- **5단계 결재 플로우** - 기안등록 → 리더결재 → 대표결재 → 협조승인 → 이체등록
- **버튼 클릭 처리** - 완료 버튼 클릭 시 다음 단계로 자동 진행
- **스레드 알림** - 각 단계 완료 시 스레드로 다음 담당자에게 알림
- **미결재 리마인드** - 12시간 쿨다운으로 미완료 건 자동 리마인드

### 그룹웨어 마감 (라포랩스, 라포스튜디오)
- **주간 자동 알림** - 매주 목요일 오전 10시 알림 발송
- **버튼 권한 제한** - 지정된 담당자만 마감완료 버튼 클릭 가능
- **이체등록 요청** - 마감완료 시 스레드로 이체담당자에게 알림
- **공휴일 자동 감지** - 설/추석 연휴 주간 자동 스킵
- **유연한 예외 설정** - 날짜 기반으로 특정 주 스킵 또는 요일 변경

---

## 정산 스케줄

| 플랫폼 | 정산일 | 정산 명칭 |
|--------|--------|-----------|
| 퀸잇 | 11일 | N월 정규 정산대금 |
| 퀸잇 | 25일 | N월 보름 정산대금 |
| 팔도감 | 1일 | N월 3차 정산대금 |
| 팔도감 | 11일 | N월 1차 정산대금 |
| 팔도감 | 21일 | N월 2차 정산대금 |

---

## 프로젝트 구조

```
settlement-reminder-bot/
├── api/
│   ├── index.js          # Slack 버튼 클릭 처리
│   ├── cron.js           # 크론 작업 (정산 알림, 그룹웨어 마감)
│   ├── config.js         # 설정 (채널, 사용자 ID, 스케줄)
│   └── utils.js          # 유틸 함수 (날짜, 영업일, 공휴일)
├── package.json
├── vercel.json           # Vercel 배포 및 크론 설정
├── .env.example
└── README.md
```

---

## 크론 스케줄

| 스케줄 | 한국시간 | 용도 |
|--------|----------|------|
| `0 0 * * 1-5` | 평일 09:00 | 정산 알림 / 리마인드 |
| `0 7 * * 1-5` | 평일 16:00 | 정산 리마인드 |
| `0 1 * * 4` | 목요일 10:00 | 그룹웨어 마감 알림 |

---

## 설정 방법

### 환경변수

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=xxx...
CRON_SECRET=your-secret-key
```

### 그룹웨어 마감 설정

`api/config.js`에서 설정:

```javascript
GROUPWARE_DEADLINE: {
  common: {
    skipHolidayWeeks: true,      // 공휴일 주간 자동 스킵
    autoShiftOnHoliday: true,    // 목요일 공휴일 시 대체 요일로 이동
    fallbackDayOfWeek: 3         // 대체 요일 (3=수요일)
  },
  rapolabs: {
    name: '라포랩스',
    channelId: 'C02DA0GK8MC',
    owners: ['U06K3R3R6QK', 'U05R2F50Y4X'],
    transferManager: 'U044Z1AB6CT',
    defaultDayOfWeek: 4,         // 기본 목요일
    exceptions: {
      // 예외 스케줄 설정
    }
  },
  rapostudio: {
    // 라포스튜디오 설정 (동일 구조)
  }
}
```

### 예외 스케줄 설정

날짜 기반으로 직관적으로 설정:

```javascript
exceptions: {
  // 해당 주 스킵
  '2025-02-06': null,

  // 해당 주 수요일(3)로 변경
  '2025-02-13': 3,

  // 특정 날짜로 변경
  '2025-02-20': '2025-02-19',
}
```

---

## 배포

### Vercel 자동 배포

GitHub `main` 브랜치에 푸시하면 Vercel이 자동 배포:

```bash
git add .
git commit -m "feat: 그룹웨어 마감 워크플로우 추가"
git push origin main
```

### Slack 앱 설정

1. https://api.slack.com/apps 에서 앱 생성
2. **OAuth & Permissions** → Bot Token Scopes 추가:
   - `chat:write`
   - `chat:write.public`
   - `commands`
3. **Interactivity & Shortcuts** → Request URL 설정:
   - `https://your-project.vercel.app/api/index`

---

## 문제 해결

### 버튼 클릭 시 권한 오류
- `config.js`의 `owners` 배열에 사용자 ID가 포함되어 있는지 확인

### 알림이 발송되지 않음
- Vercel 대시보드에서 Function Logs 확인
- 크론 스케줄이 올바른지 확인 (UTC 기준)

### 공휴일 스킵이 안 됨
- `utils.js`의 공휴일 목록에 해당 날짜가 있는지 확인

---

## 라이선스

MIT

---

**Happy Bot Deploying!**
