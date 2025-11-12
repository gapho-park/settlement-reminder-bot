// api/remind.js
// 리마인더 수동 실행 엔드포인트
// 사용: /api/remind?platform=queenit&month=11

const axios = require('axios');
const CONFIG = require('./config');

// ============================================
// 설정
// ============================================
const APPROVAL_FLOW = {
  queenit: {
    steps: [
      { role: 'settlement_owner', userId: 'U02JESZKDAT', message: '{title} 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
    ]
  },
  paldogam: {
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

  async getChannelHistory(channel, limit = 100) {
    try {
      console.log(`📜 채널 메시지 조회: channel=${channel}, limit=${limit}`);
      
      // 1단계: channels.history 시도 (공개 채널)
      console.log(`📺 channels.history 시도...`);
      let response = await axios.get(`${this.baseURL}/channels.history`, {
        headers: this.headers,
        params: { channel, limit }
      });

      if (response.data.ok) {
        console.log(`✅ channels.history 성공: ${response.data.messages.length}개 메시지`);
        return response.data.messages || [];
      }

      // 2단계: groups.history 시도 (그룹 채널)
      console.log(`📋 groups.history 시도...`);
      response = await axios.get(`${this.baseURL}/groups.history`, {
        headers: this.headers,
        params: { channel, limit }
      });

      if (response.data.ok) {
        console.log(`✅ groups.history 성공: ${response.data.messages.length}개 메시지`);
        return response.data.messages || [];
      }

      // 3단계: im.history 시도 (DM)
      console.log(`💬 im.history 시도...`);
      response = await axios.get(`${this.baseURL}/im.history`, {
        headers: this.headers,
        params: { channel, limit }
      });

      if (response.data.ok) {
        console.log(`✅ im.history 성공: ${response.data.messages.length}개 메시지`);
        return response.data.messages || [];
      }

      console.error('❌ 모든 메시지 조회 시도 실패:', response.data.error);
      return [];
    } catch (err) {
      console.error('❌ getChannelHistory 실패:', err.message);
      return [];
    }
  }
}

const slack = new SlackClient();

// ============================================
// 메인 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`\n${'='.repeat(50)}`);
  console.log('⏰ 리마인더 수동 실행');
  console.log(`${'='.repeat(50)}\n`);

  try {
    // 파라미터 검증
    const { platform, month } = req.query;

    if (!platform || !month) {
      console.warn('⚠️ 파라미터 누락: platform, month 필요');
      return res.status(400).json({
        ok: false,
        error: '파라미터 필요: ?platform=queenit&month=11'
      });
    }

    if (!APPROVAL_FLOW[platform]) {
      console.warn('⚠️ 잘못된 플랫폼:', platform);
      return res.status(400).json({
        ok: false,
        error: 'platform은 queenit 또는 paldogam만 가능'
      });
    }

    const monthNum = parseInt(month);
    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      console.warn('⚠️ 잘못된 월:', month);
      return res.status(400).json({
        ok: false,
        error: 'month는 1-12 사이의 숫자'
      });
    }

    console.log(`📢 파라미터: platform=${platform}, month=${monthNum}`);

    // 채널 선택
    const channelId = CONFIG.FINANCE_CHANNEL_ID;
    console.log(`📢 사용 채널: ${channelId}`);

    // 미완료 건 조회
    console.log(`\n📋 ${platform} ${monthNum}월 미완료 건 확인 시작`);
    const messages = await slack.getChannelHistory(channelId, 100);

    if (messages.length === 0) {
      console.log('📌 조회된 메시지 없음');
      return res.status(200).json({
        ok: true,
        reminded: 0,
        message: '조회된 메시지 없음'
      });
    }

    // 미완료 건 찾기
    const incompleteSettlements = [];

    for (const msg of messages) {
      if (msg.text && !msg.text.startsWith('✅')) {
        if (msg.text.includes(platform) && msg.text.includes(`${monthNum}월`)) {
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
      console.log(`✅ ${platform} ${monthNum}월 미완료 건 없음`);
      return res.status(200).json({
        ok: true,
        reminded: 0,
        message: '미완료 건 없음'
      });
    }

    // 각 미완료 건에 리마인더 발송
    let reminded = 0;
    for (const settlement of incompleteSettlements) {
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
        const reminderMsg = `⏰ *리마인더* <@${userToRemind}>님, ${platform} ${monthNum}월 정산건이 아직 완료되지 않았습니다. 확인 부탁드립니다.\n시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`;

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

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 리마인더 완료 - ${reminded}건 발송`);
    console.log(`${'='.repeat(50)}\n`);

    return res.status(200).json({
      ok: true,
      reminded,
      total: incompleteSettlements.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ 리마인더 실행 오류:', err);
    console.error(err.stack);

    return res.status(500).json({
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
};
