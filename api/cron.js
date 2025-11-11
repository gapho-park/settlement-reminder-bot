// api/cron.js
// 정산 알림 자동화 (매일 09:00 실행)
// 퀸잇: 11일, 25일 / 팔도감: 1일, 11일, 25일

const axios = require('axios');
const CONFIG = require('./config');
const { stripTime, formatDate } = require('./utils');

// ============================================
// 설정
// ============================================
const APPROVAL_FLOW = {
  queenit: {
    dates: [11, 25],
    steps: [
      { role: 'settlement_owner', userId: 'U02JESZKDAT', message: '퀸잇 {month}월 정산대금 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '퀸잇 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '퀸잇 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '퀸잇 {month}월 정산대금 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '퀸잇 {month}월 정산대금 이체요청드립니다.' }
    ]
  },
  paldogam: {
    dates: [1, 11, 25],
    steps: [
      { role: 'settlement_owner', userId: 'U0499M26EJ2', message: '팔도감 {month}월 정산대금 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '팔도감 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '팔도감 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '팔도감 {month}월 정산대금 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '팔도감 {month}월 정산대금 이체요청드립니다.' }
    ]
  }
};

// ============================================
// Slack API 클라이언트
// ============================================
class SlackClient {
  constructor() {
    this.baseURL = 'https://slack.com/api';
    this.headers = {
      'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    };
  }

  async postMessage(channel, payload) {
    try {
      console.log(`📤 Slack 메시지 전송: channel=${channel}`);
      const response = await axios.post(`${this.baseURL}/chat.postMessage`, {
        channel,
        ...payload
      }, { headers: this.headers });

      if (!response.data.ok) {
        console.error('❌ Slack API 오류:', response.data.error);
        return null;
      }
      console.log('✅ 메시지 전송 성공:', response.data.ts);
      return response.data;
    } catch (err) {
      console.error('❌ postMessage 실패:', err.message);
      return null;
    }
  }
}

const slack = new SlackClient();

// ============================================
// 메인 크론 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log('⏰ 크론 작업 시작');
  console.log(`${'='.repeat(50)}\n`);

  try {
    // 크론 시크릿 검증
    if (CONFIG.CRON_SECRET) {
      const authHeader = req.headers['authorization'];
      const secret = authHeader?.replace('Bearer ', '');

      if (secret !== CONFIG.CRON_SECRET) {
        console.warn('⚠️ 크론 시크릿 검증 실패');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // 현재 날짜 계산 (testDate 지원)
    let today;
    if (req.query.testDate) {
      console.log(`🧪 테스트 모드: testDate=${req.query.testDate}`);
      const [year, month, day] = req.query.testDate.split('-').map(Number);
      today = new Date(year, month - 1, day);
    } else {
      today = new Date();
    }

    const todayStr = formatDate(today);
    const currentDay = today.getDate();
    const currentMonth = today.getMonth() + 1;
    console.log(`📅 오늘 날짜: ${todayStr} (${currentDay}일)`);

    let alertsSent = 0;

    // ============================================
    // Queenit 정산 알림
    // ============================================
    console.log('\n🔍 Queenit 정산 확인');
    if (APPROVAL_FLOW.queenit.dates.includes(currentDay)) {
      console.log(`✅ Queenit ${currentDay}일 알림 발송 대상`);
      await sendFirstApprovalAlert('queenit', currentMonth, currentDay);
      alertsSent++;
    } else {
      console.log(`📌 Queenit: 오늘(${currentDay}일)은 알림 대상이 아님`);
    }

    // ============================================
    // Paldogam 정산 알림
    // ============================================
    console.log('\n🔍 Paldogam 정산 확인');
    if (APPROVAL_FLOW.paldogam.dates.includes(currentDay)) {
      console.log(`✅ Paldogam ${currentDay}일 알림 발송 대상`);
      await sendFirstApprovalAlert('paldogam', currentMonth, currentDay);
      alertsSent++;
    } else {
      console.log(`📌 Paldogam: 오늘(${currentDay}일)은 알림 대상이 아님`);
    }

    // ============================================
    // 결과 반환
    // ============================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 크론 작업 완료 - ${alertsSent}건 발송`);
    console.log(`${'='.repeat(50)}\n`);

    return res.status(200).json({
      ok: true,
      alertsSent,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ 크론 작업 오류:', err);
    console.error(err.stack);

    return res.status(500).json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
};

// ============================================
// 첫 번째 승인 알림 발송
// ============================================
async function sendFirstApprovalAlert(platform, month, day) {
  const flow = APPROVAL_FLOW[platform];
  const firstStep = flow.steps[0];

  const message = `<@${firstStep.userId}>님 ${firstStep.message.replace('{month}', month)}`;

  const payload = {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "완료" },
            value: JSON.stringify({ platform, step: 0, month }),
            action_id: "settlement_approve_button"
          }
        ]
      }
    ]
  };

  const result = await slack.postMessage(CONFIG.TEST_CHANNEL_ID, payload);

  if (result) {
    console.log(`✅ ${platform} ${month}월 첫 번째 알림 발송`);
  } else {
    console.error(`❌ ${platform} ${month}월 알림 발송 실패`);
  }
}
