// api/config.js
const CONFIG = {
  // Slack 토큰 및 시크릿 (환경변수에서 로드)
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,

  // 채널 및 사용자 ID
  TEST_CHANNEL_ID: "C096PH0906N",           // 테스트 채널/DM
  FINANCE_CHANNEL_ID: "C02DA0GK8MC",       // finance-finance 채널
  NOTIFY_USER_ID: "U06K3R3R6QK",           // 알림 받을 담당자
  ACTION_USER_ID: "U044Z1AB6CT",           // 결재완료 후 이체 요청 받을 사람

  // 미결재 리마인드 정책
  REMINDER_TIMES: ["09:00", "16:00"],      // 업무일 기준 리마인드 시각(HH:mm)
  REMINDER_MAX_DAYS: 5,                    // 최초 알림 이후 최대 리마인드 일수

  // 타임존
  TIMEZONE: "Asia/Seoul",

  // ============================================
  // 그룹웨어 마감 워크플로우 설정
  // ============================================
  GROUPWARE_DEADLINE: {
    // 공통 설정
    common: {
      // 공휴일 주간 자동 스킵 (설, 추석 등 연휴 포함된 주)
      skipHolidayWeeks: true,
      // 공휴일이 목요일인 경우 수요일로 자동 이동
      autoShiftOnHoliday: true,
      // 자동 이동 시 대체 요일 (3=수요일, 5=금요일)
      fallbackDayOfWeek: 3
    },
    // 라포랩스 설정
    rapolabs: {
      name: '라포랩스',
      channelId: 'C02DA0GK8MC',
      owners: ['U06K3R3R6QK', 'U05R2F50Y4X'],
      transferManager: 'U044Z1AB6CT',
      defaultDayOfWeek: 4,  // 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토
      // 예외 스케줄 (날짜 기반 - 더 직관적!)
      // 형식: { 'YYYY-MM-DD': null | dayOfWeek | 'YYYY-MM-DD' }
      //   null = 해당 주 스킵
      //   숫자 = 해당 요일로 변경 (같은 주 내)
      //   날짜 = 특정 날짜로 변경
      exceptions: {
        // 예시:
        // '2025-02-06': null,         // 2월 6일이 포함된 주 스킵
        // '2025-02-13': 3,            // 2월 13일 주는 수요일(3)로 변경
        // '2025-02-20': '2025-02-19', // 2월 20일 주는 19일로 변경
      }
    },
    // 라포스튜디오 설정
    rapostudio: {
      name: '라포스튜디오',
      channelId: 'C02DA0GK8MC',
      owners: ['U06K3R3R6QK', 'U05R2F50Y4X'],
      transferManager: 'U044Z1AB6CT',
      defaultDayOfWeek: 4,
      exceptions: {
        // 예시:
        // '2025-03-06': null,         // 3월 6일이 포함된 주 스킵
        // '2025-03-13': 5,            // 3월 13일 주는 금요일(5)로 변경
      }
    }
  }
};

// 환경변수 검증
function validateConfig() {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = required.filter(key => !CONFIG[key]);

  if (missing.length > 0) {
    console.error('❌ 필수 환경변수 누락:', missing.join(', '));
    console.error('⚠️ .env 파일 또는 Vercel 환경변수 설정 필요');
    // 개발 환경에서만 경고, 프로덕션에서는 계속 진행
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

validateConfig();

module.exports = CONFIG;
