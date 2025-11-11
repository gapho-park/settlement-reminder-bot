// api/index.js
// Slack 버튼 클릭 처리 및 승인 플로우 관리

const axios = require('axios');
const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const CONFIG = require('./config');

// ============================================
// 설정
// ============================================
const APPROVAL_FLOW = {
  queenit: {
    steps: [
      { role: 'settlement_owner', userId: 'U02JESZKDAT', message: '퀸잇 {month}월 정산대금 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead', userId: 'U03ABD7F9DE', message: '퀸잇 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'ceo', userId: 'U013R34Q719', message: '퀸잇 {month}월 정산대금 결재 요청 드립니다.' },
      { role: 'accounting', userId: 'U06K3R3R6QK', message: '퀸잇 {month}월 정산대금 결재가 완료되었나요?' },
      { role: 'fund_manager', userId: 'U044Z1AB6CT', message: '퀸잇 {month}월 정산대금 이체요청드립니다.' }
    ]
  },
  paldogam: {
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
// Slack 요청 검증
// ============================================
function verifySlackRequest(req) {
  const slackSigningSecret = CONFIG.SLACK_SIGNING_SECRET;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];
  
  if (!timestamp || !slackSignature) {
    console.warn('⚠️ Slack 타임스탬프 또는 시그니처 없음');
    return false;
  }
  
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.warn('⚠️ 요청이 너무 오래됨 (5분 이상)');
    return false;
  }

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hash = `v0=${crypto
    .createHmac('sha256', slackSigningSecret)
    .update(baseString)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(slackSignature)
    );
  } catch (err) {
    console.error('❌ 시그니처 검증 실패:', err.message);
    return false;
  }
}

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
}

const slack = new SlackClient();

// ============================================
// 버튼 클릭 처리
// ============================================
async function handleButtonClick(payload) {
  console.log('✅ Block actions 수신');
  
  const action = payload.actions?.[0];
  if (!action) {
    console.warn('⚠️ actions 없음');
    return { ok: true };
  }

  let actionData = null;
  try {
    actionData = JSON.parse(action.value);
  } catch (_) {
    console.warn('⚠️ 액션 데이터 파싱 실패');
    return { ok: false };
  }

  const { settlementId, platform, step } = actionData;
  const channelId = payload.container?.channel_id || payload.channel?.id;
  const ts = payload.container?.message_ts || payload.message?.ts;
  const userId = payload.user?.id;
  const userName = payload.user?.name || 'Unknown';

  console.log(`🔄 승인 처리: ${settlementId}, step=${step}, userId=${userId}`);

  // ============================================
  // KV에서 정산건 조회
  // ============================================
  let settlement;
  try {
    settlement = await kv.hgetall(settlementId);
  } catch (err) {
    console.error('❌ KV 조회 실패:', err.message);
    return { ok: false };
  }

  if (!settlement) {
    console.error('❌ 정산건을 찾을 수 없음:', settlementId);
    return { ok: false };
  }

  const flow = APPROVAL_FLOW[platform];
  const currentStepData = flow.steps[step];
  const nextStep = step + 1;
  const isLastStep = nextStep >= flow.steps.length;
  const month = settlement.month;

  // ============================================
  // 현재 단계 메시지 업데이트 (완료 표시)
  // ============================================
  const currentStepBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *${platform.toUpperCase()} ${month}월 정산* - ${currentStepData.role}`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `승인자: <@${userId}> (${userName}) | 시간: ${new Date().toLocaleString('ko-KR')}`
        }
      ]
    }
  ];

  const updated = await slack.updateMessage(channelId, ts, {
    blocks: currentStepBlocks,
    text: `${platform} ${month}월 정산 - 완료`
  });

  if (!updated) {
    console.warn('⚠️ 메시지 업데이트 실패');
  }

  // ============================================
  // 마지막 단계 완료
  // ============================================
  if (isLastStep) {
    console.log(`🎉 모든 승인 완료: ${settlementId}`);
    
    // KV 정산건 삭제
    await kv.del(settlementId);

    // 스레드에 완료 메시지
    await slack.postMessage(channelId, {
      thread_ts: ts,
      text: `✅ 모든 승인이 완료되었습니다!\n정산건: ${platform} ${month}월\n이체 등록 처리 완료`
    });

    return { ok: true };
  }

  // ============================================
  // 다음 단계로 진행
  // ============================================
  console.log(`➡️ 다음 단계로: step=${nextStep}`);

  // KV 업데이트
  await kv.hset(settlementId, { currentStep: nextStep });

  const nextStepData = flow.steps[nextStep];
  const nextMessage = `<@${nextStepData.userId}>님 ${nextStepData.message.replace('{month}', month)}`;

  // 스레드에 다음 단계 메시지 추가
  const threadResult = await slack.postMessage(channelId, {
    thread_ts: ts,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: nextMessage
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "완료" },
            value: JSON.stringify({ settlementId, platform, step: nextStep }),
            action_id: "settlement_approve_button"
          }
        ]
      }
    ]
  });

  if (threadResult) {
    console.log(`✅ 다음 단계 메시지 발송: ${nextStepData.role}`);
  }

  return { ok: true };
}

// ============================================
// 메인 핸들러
// ============================================
module.exports = async (req, res) => {
  console.log(`📨 요청 수신: ${req.method}`);

  if (req.method === 'OPTIONS') {
    console.log('✅ OPTIONS 요청 응답');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.warn('❌ POST가 아닌 요청:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';

  return new Promise((resolve, reject) => {
    req.on('data', chunk => {
      body += chunk.toString();
    });
  
    req.on('end', async () => {
      try {
        req.rawBody = body;
  
        if (!verifySlackRequest(req)) {
          console.warn('⚠️ Slack 검증 실패');
          return resolve(res.status(401).json({ error: 'Unauthorized' }));
        }

        console.log('✅ Slack 검증 성공');

        // Payload 파싱
        let payload;
        try {
          if (body.startsWith('payload=')) {
            const params = new URLSearchParams(body);
            payload = JSON.parse(params.get('payload'));
          } else {
            payload = JSON.parse(body);
          }
        } catch (err) {
          console.error('❌ Payload 파싱 실패:', err.message);
          return resolve(res.status(400).json({ error: 'Invalid payload' }));
        }

        console.log('📋 Payload type:', payload.type);

        // URL Verification
        if (payload.type === 'url_verification') {
          console.log('✅ URL Verification 요청');
          return resolve(res.status(200).json({ 
            challenge: payload.challenge 
          }));
        }

        // Block Actions
        if (payload.type === 'block_actions') {
          console.log('🎬 Block actions 처리 시작');
          const result = await handleButtonClick(payload);
          return resolve(res.status(200).json(result));
        }

        console.log('ℹ️ 처리되지 않은 이벤트 타입:', payload.type);
        return resolve(res.status(200).json({ ok: true }));

      } catch (err) {
        console.error('❌ 핸들러 오류:', err);
        return resolve(res.status(500).json({ 
          error: err.message 
        }));
      }
    });

    req.on('error', (err) => {
      console.error('❌ 요청 스트림 오류:', err);
      return resolve(res.status(500).json({ 
        error: 'Request stream error' 
      }));
    });
  });
};
