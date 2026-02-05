// api/index.js
// Slack 버튼 클릭 처리 및 5단계 승인 플로우

const axios = require('axios');
const crypto = require('crypto');
const CONFIG = require('./config');

// ============================================
// 설정
// ============================================
// 정산 유형별 제목 생성 함수
function getSettlementTitle(platform, day, month) {
  if (platform === 'queenit') {
    if (day === 11) return `퀸잇 ${month}월 정규 정산대금`;
    if (day === 25) return `퀸잇 ${month}월 보름 정산대금`;
  } else if (platform === 'paldogam') {
    // 1일 정산은 전월 3차 정산 (예: 2월 1일 = 1월 3차 정산)
    if (day === 1) {
      const prevMonth = month === 1 ? 12 : month - 1;
      return `팔도감 ${prevMonth}월 3차 정산대금`;
    }
    if (day === 11) return `팔도감 ${month}월 1차 정산대금`;
    if (day === 21) return `팔도감 ${month}월 2차 정산대금`;
  }
  return `${platform} ${month}월 정산대금`;
}

const STEP_COMPLETION_TEXT = [
  '결재요청 단계 완료',
  '결재승인 완료 (리더)',
  '결재승인 완료 (대표이사)',
  '협조승인 완료',
  '이체등록 완료'
];

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

  async addReaction(channel, timestamp, name) {
    try {
      console.log(`😀 이모지 반응 추가: channel=${channel}, ts=${timestamp}, name=${name}`);
      const response = await axios.post(`${this.baseURL}/reactions.add`, {
        channel,
        timestamp,
        name
      }, { headers: this.headers });
      
      if (!response.data.ok) {
        // 이미 반응이 있는 경우도 정상으로 처리
        if (response.data.error === 'already_reacted') {
          console.log('ℹ️ 이미 반응이 추가되어 있음');
          return true;
        }
        console.error('❌ reactions.add 오류:', response.data.error);
        return false;
      }
      console.log('✅ 이모지 반응 추가 성공');
      return true;
    } catch (err) {
      console.error('❌ addReaction 실패:', err.message);
      return false;
    }
  }

  async getMessage(channel, ts) {
    try {
      console.log(`📋 메시지 조회: channel=${channel}, ts=${ts}`);
      const response = await axios.get(`${this.baseURL}/conversations.replies`, {
        headers: this.headers,
        params: {
          channel,
          ts,
          limit: 1
        }
      });
      
      if (!response.data.ok) {
        console.error('❌ conversations.replies 오류:', response.data.error);
        return null;
      }
      
      const messages = response.data.messages || [];
      if (messages.length === 0) {
        console.log('ℹ️ 메시지를 찾을 수 없음');
        return null;
      }
      
      console.log('✅ 메시지 조회 성공');
      return messages[0]; // 최초 메시지 반환
    } catch (err) {
      console.error('❌ getMessage 실패:', err.message);
      return null;
    }
  }
}

const slack = new SlackClient();

// ============================================
// 그룹웨어 마감 버튼 클릭 처리
// ============================================
async function handleGroupwareDeadlineButton(payload, actionData) {
  const { company, companyName, transferManager, allowedUsers } = actionData;
  const channelId = payload.container?.channel_id || payload.channel?.id;
  const ts = payload.container?.message_ts || payload.message?.ts;
  const userId = payload.user?.id;
  const userName = payload.user?.name || 'Unknown';

  console.log(`🏢 그룹웨어 마감 버튼 클릭: company=${companyName}, userId=${userId}`);

  // 권한 확인
  if (!allowedUsers.includes(userId)) {
    console.warn(`⚠️ 권한 없는 사용자: ${userId}`);
    // Slack에서 ephemeral 메시지로 알림 (해당 사용자에게만 보이는 메시지)
    try {
      await axios.post('https://slack.com/api/chat.postEphemeral', {
        channel: channelId,
        user: userId,
        text: `⚠️ 마감완료 버튼은 지정된 담당자만 클릭할 수 있습니다.`
      }, {
        headers: {
          'Authorization': `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.error('❌ ephemeral 메시지 전송 실패:', err.message);
    }
    return { ok: true };
  }

  const approvalTimeKst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 원본 메시지 업데이트 (완료 표시)
  const completedBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *${companyName} 그룹웨어 마감 완료*`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `완료자: <@${userId}> (${userName}) | 시간: ${approvalTimeKst}`
        }
      ]
    }
  ];

  await slack.updateMessage(channelId, ts, {
    blocks: completedBlocks,
    text: `${companyName} 그룹웨어 마감 완료`
  });

  // 스레드에 이체등록 요청 메시지 작성
  const transferMessage = `<@${transferManager}>님 ${companyName} 그룹웨어 마감이 완료되었습니다. 이체등록을 해주세요.`;

  await slack.postMessage(channelId, {
    thread_ts: ts,
    text: transferMessage
  });

  console.log(`✅ ${companyName} 그룹웨어 마감 처리 완료, 이체등록 요청 발송`);

  return { ok: true };
}

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

  // 그룹웨어 마감 버튼 처리
  if (action.action_id === 'groupware_deadline_button') {
    return await handleGroupwareDeadlineButton(payload, actionData);
  }

  const { platform, step, month, day, title } = actionData;
  const channelId = payload.container?.channel_id || payload.channel?.id;
  const ts = payload.container?.message_ts || payload.message?.ts;
  const userId = payload.user?.id;
  const userName = payload.user?.name || 'Unknown';

  console.log(`🔄 승인 처리: platform=${platform}, step=${step}, userId=${userId}`);

  if (!APPROVAL_FLOW[platform]) {
    console.error('❌ 잘못된 플랫폼:', platform);
    return { ok: false };
  }

  const flow = APPROVAL_FLOW[platform];
  const currentStepData = flow.steps[step];
  const nextStep = step + 1;
  const isLastStep = nextStep >= flow.steps.length;
  
  // title이 없으면 생성
  const settlementTitle = title || getSettlementTitle(platform, day, month);
  const approvalTimeKst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const completionText = STEP_COMPLETION_TEXT[step] || `${currentStepData.role} 단계 완료`;

  // ============================================
  // 현재 단계 메시지 업데이트 (완료 표시)
  // ============================================
  const completedBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *${settlementTitle}*`
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: completionText
        },
        {
          type: "mrkdwn",
          text: `승인자: <@${userId}> (${userName}) | 시간: ${approvalTimeKst}`
        }
      ]
    }
  ];

  const updated = await slack.updateMessage(channelId, ts, {
    blocks: completedBlocks,
    text: `${settlementTitle} - ${completionText}`
  });

  if (!updated) {
    console.warn('⚠️ 메시지 업데이트 실패');
  }

  // ============================================
  // 마지막 단계 완료
  // ============================================
  if (isLastStep) {
    console.log(`🎉 모든 승인 완료: ${platform} ${month}월`);

    // 스레드에 최종 완료 메시지
    await slack.postMessage(channelId, {
      thread_ts: ts,
      text: `✅ 모든 승인이 완료되었습니다!\n정산건: ${settlementTitle}\n이체 등록 처리 완료`
    });

    return { ok: true };
  }

  // ============================================
  // 다음 단계로 진행
  // ============================================
  console.log(`➡️ 다음 단계로: step=${nextStep}`);

  const nextStepData = flow.steps[nextStep];
  const nextMessage = `<@${nextStepData.userId}>님 ${nextStepData.message.replace('{title}', settlementTitle)}`;

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
            value: JSON.stringify({ platform, step: nextStep, month, day, title: settlementTitle }),
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
// 스레드 댓글 완료 감지 및 이모지 추가
// ============================================
async function handleMessageEvent(payload) {
  console.log('💬 Message 이벤트 수신');

  // 봇 메시지는 무시
  if (payload.event?.subtype === 'bot_message' || payload.event?.bot_id) {
    console.log('ℹ️ 봇 메시지 무시');
    return { ok: true };
  }

  // 스레드 댓글이 아니면 무시
  const threadTs = payload.event?.thread_ts;
  if (!threadTs) {
    console.log('ℹ️ 스레드 댓글이 아님 - 무시');
    return { ok: true };
  }

  // 메시지 텍스트 확인
  const messageText = (payload.event?.text || '').toLowerCase().trim();
  const channelId = payload.event?.channel;
  const parentMessageTs = threadTs;

  // 최초 메시지 조회하여 그룹웨어 알림인지 확인
  const parentMessage = await slack.getMessage(channelId, parentMessageTs);
  let isGroupwareMessage = false;
  
  if (parentMessage) {
    // 그룹웨어 알림 메시지인지 확인 (버튼의 action_id로 판단)
    const hasGroupwareButton = (parentMessage.blocks || []).some(block =>
      block.type === 'actions' && block.elements?.some(el =>
        el.action_id === 'groupware_deadline_button'
      )
    );
    
    if (hasGroupwareButton) {
      isGroupwareMessage = true;
      console.log('🏢 그룹웨어 알림 메시지로 확인됨');
    }
  }

  // 완료 키워드 확인
  let hasCompletionKeyword = false;
  
  if (isGroupwareMessage) {
    // 그룹웨어 알림: "예약완료"만 감지
    hasCompletionKeyword = messageText.includes('예약완료');
    if (hasCompletionKeyword) {
      console.log(`✅ 그룹웨어 알림 - "예약완료" 키워드 감지: "${messageText}"`);
    }
  } else {
    // 정산 알림: 여러 완료 키워드 감지
    const completionKeywords = ['예약완료', '완료', 'done', '완료됨', '처리완료', '등록완료'];
    hasCompletionKeyword = completionKeywords.some(keyword => 
      messageText.includes(keyword.toLowerCase())
    );
    if (hasCompletionKeyword) {
      console.log(`✅ 정산 알림 - 완료 키워드 감지: "${messageText}"`);
    }
  }

  if (!hasCompletionKeyword) {
    console.log('ℹ️ 완료 키워드 없음 - 무시');
    return { ok: true };
  }

  // 최초 메시지에 이모지 반응 추가
  const emojiAdded = await slack.addReaction(channelId, parentMessageTs, 'white_check_mark');
  
  if (emojiAdded) {
    console.log(`✅ 최초 메시지에 완료 이모지 추가: channel=${channelId}, ts=${parentMessageTs}`);
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

        // Event Callback (메시지 이벤트)
        if (payload.type === 'event_callback') {
          console.log('📨 Event callback 처리 시작');
          if (payload.event?.type === 'message') {
            const result = await handleMessageEvent(payload);
            return resolve(res.status(200).json(result));
          }
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
