// api/cron.js
// 정산 알림 자동화 (매일 09:00 실행)
// 1. 정산일: 첫 알림 발송
// 2. 정산일 아님: 미완료 건 리마인드

const axios = require('axios');
const CONFIG = require('./config');
const { stripTime, formatDate } = require('./utils');

// ============================================
// 정산 유형별 제목 생성 함수
// ============================================
function getSettlementTitle(platform, day, month) {
  if (platform === 'queenit') {
    if (day === 11) return `퀸잇 ${month}월 정규 정산대금`;
    if (day === 25) return `퀸잇 ${month}월 보름 정산대금`;
  } else if (platform === 'paldogam') {
    if (day === 1) return `팔도감 ${month}월 3차 정산대금`;
    if (day === 11) return `팔도감 ${month}월 1차 정산대금`;
    if (day === 21) return `팔도감 ${month}월 2차 정산대금`;
  }
  return `${platform} ${month}월 정산대금`;
}

// ============================================
// 설정
// ============================================
const APPROVAL_FLOW = {
  queenit: {
    dates: [11, 25],
    steps: [
      { role: 'settlement_owner', userId: 'U02JESZKDAT', message: '{title} 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
    ]
  },
  paldogam: {
    dates: [1, 11, 21],
    steps: [
      { role: 'settlement_owner', userId: 'U0499M26EJ2', message: '{title} 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
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

  async updateMessage(channel, ts, payload) {
    try {
      console.log(`🔄 메시지 업데이트: channel=${channel}, ts=${ts}`);
      const response = await axios.post(`${this.baseURL}/chat.update`, {
        channel,
        ts,
        ...payload
      }, { headers: this.headers });

      if (!response.data.ok) {
        console.error('❌ chat.update 오류:', response.data.error);
        return false;
      }
      console.log('✅ 메시지 업데이트 성공');
      return true;
    } catch (err) {
      console.error('❌ updateMessage 실패:', err.message);
      return false;
    }
  }

  async getConversationHistory(channel, limit = 100) {
    try {
      console.log(`📜 채널 메시지 조회: channel=${channel}, limit=${limit}`);
      const response = await axios.post(`${this.baseURL}/conversations.history`, {
        channel,
        limit
      }, { headers: this.headers });

      if (!response.data.ok) {
        console.error('❌ conversations.history 오류:', response.data.error);
        return [];
      }
      console.log(`✅ ${response.data.messages.length}개 메시지 조회됨`);
      return response.data.messages || [];
    } catch (err) {
      console.error('❌ getConversationHistory 실패:', err.message);
      return [];
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

    // 채널 선택: testDate가 있으면 테스트 채널, 아니면 파이낸스 채널
    const channelId = req.query.testDate ? CONFIG.TEST_CHANNEL_ID : CONFIG.FINANCE_CHANNEL_ID;
    console.log(`📢 사용 채널: ${channelId}`);

    let alertsSent = 0;

    // ============================================
    // Queenit 정산 확인
    // ============================================
    console.log('\n🔍 Queenit 정산 확인');
    if (APPROVAL_FLOW.queenit.dates.includes(currentDay)) {
      // 정산일: 첫 알림 발송
      console.log(`✅ Queenit ${currentDay}일 정산일 - 첫 알림 발송`);
      await sendFirstApprovalAlert('queenit', currentMonth, currentDay, channelId);
      alertsSent++;
    } else {
      // 정산일 아님: 미완료 건 리마인드
      console.log(`📌 Queenit: 오늘(${currentDay}일)은 정산일이 아님 - 미완료 건 확인`);
      const reminded = await remindIncompleteSettlements('queenit', currentMonth, channelId);
      alertsSent += reminded;
    }

    // ============================================
    // Paldogam 정산 확인
    // ============================================
    console.log('\n🔍 Paldogam 정산 확인');
    if (APPROVAL_FLOW.paldogam.dates.includes(currentDay)) {
      // 정산일: 첫 알림 발송
      console.log(`✅ Paldogam ${currentDay}일 정산일 - 첫 알림 발송`);
      await sendFirstApprovalAlert('paldogam', currentMonth, currentDay, channelId);
      alertsSent++;
    } else {
      // 정산일 아님: 미완료 건 리마인드
      console.log(`📌 Paldogam: 오늘(${currentDay}일)은 정산일이 아님 - 미완료 건 확인`);
      const reminded = await remindIncompleteSettlements('paldogam', currentMonth, channelId);
      alertsSent += reminded;
    }

    // ============================================
    // 결과 반환
    // ============================================
    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 크론 작업 완료 - ${alertsSent}건 처리`);
    console.log(`${'='.repeat(50)}\n`);

    return res.status(200).json({
      ok: true,
      processed: alertsSent,
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
async function sendFirstApprovalAlert(platform, month, day, channelId) {
  const flow = APPROVAL_FLOW[platform];
  const firstStep = flow.steps[0];
  const title = getSettlementTitle(platform, day, month);

  const message = `<@${firstStep.userId}>님 ${firstStep.message.replace('{title}', title)}`;

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
            value: JSON.stringify({ platform, step: 0, month, day, title }),
            action_id: "settlement_approve_button"
          }
        ]
      }
    ]
  };

  const result = await slack.postMessage(channelId, payload);

  if (result) {
    console.log(`✅ ${platform} ${month}월 첫 번째 알림 발송`);
  } else {
    console.error(`❌ ${platform} ${month}월 알림 발송 실패`);
  }
}

// ============================================
// 미완료 건 리마인드 (매일 새 멘션 메시지)
// ============================================
async function remindIncompleteSettlements(platform, month, channelId) {
  console.log(`\n📋 ${platform} ${month}월 미완료 건 확인 시작`);

  // 채널 메시지 조회
  const messages = await slack.getConversationHistory(channelId, 100);

  if (messages.length === 0) {
    console.log('📌 조회된 메시지 없음');
    return 0;
  }

  // 미완료 건 찾기
  const incompleteSettlements = [];

  for (const msg of messages) {
    // ✅로 시작하지 않는 메시지 = 미완료
    if (msg.text && !msg.text.startsWith('✅')) {
      // platform과 month가 포함된 메시지만 찾기
      if (msg.text.includes(platform) && msg.text.includes(`${month}월`)) {
        // 버튼이 있는 메시지인지 확인 (완료 버튼이 있으면 미완료)
        if (msg.blocks) {
          const hasButton = msg.blocks.some(block => 
            block.type === 'actions' && 
            block.elements?.some(el => el.action_id === 'settlement_approve_button')
          );

          if (hasButton) {
            incompleteSettlements.push(msg);
            console.log(`📌 미완료 건 발견: ${msg.text.substring(0, 50)}`);
          }
        }
      }
    }
  }

  if (incompleteSettlements.length === 0) {
    console.log(`✅ ${platform} ${month}월 미완료 건 없음`);
    return 0;
  }

  // 각 미완료 건에 리마인드 메시지 추가
  let reminded = 0;
  for (const settlement of incompleteSettlements) {
    // 현재 완료되지 않은 단계의 담당자 찾기
    let currentStep = 0;
    let userToRemind = null;

    // 메시지의 버튼 value에서 step 정보 추출
    if (settlement.blocks) {
      const actionBlock = settlement.blocks.find(b => b.type === 'actions');
      if (actionBlock?.elements?.[0]?.value) {
        try {
          const actionData = JSON.parse(actionBlock.elements[0].value);
          currentStep = actionData.step;
          const flow = APPROVAL_FLOW[platform];
          if (flow && flow.steps[currentStep]) {
            userToRemind = flow.steps[currentStep].userId;
          }
        } catch (err) {
          console.warn('⚠️ 버튼 데이터 파싱 실패');
        }
      }
    }

    if (userToRemind) {
      const reminderMsg = `⏰ *리마인더* <@${userToRemind}>님, ${platform} ${month}월 정산건이 아직 완료되지 않았습니다. 확인 부탁드립니다.\n시간: ${new Date().toLocaleString('ko-KR')}`;

      const result = await slack.postMessage(channelId, {
        thread_ts: settlement.ts,
        text: reminderMsg
      });

      if (result) {
        console.log(`✅ 리마인더 메시지 발송: ${userToRemind}`);
        reminded++;
      }
    }
  }

  console.log(`📊 ${platform} ${month}월: ${reminded}건 리마인드`);
  return reminded;
}
