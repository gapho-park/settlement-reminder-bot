// api/cron.js
// 정산 알림 자동화 (매일 09:00 실행)
// 1. 정산일: 첫 알림 발송
// 2. 정산일 아님: 미완료 건 리마인드

const axios = require('axios');
const CONFIG = require('./config');
const { stripTime, formatDate, getISOWeek, isHoliday, isHolidayOrWeekend } = require('./utils');

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
      { role: 'finance_lead',    userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo',             userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting_manager',      userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'finance_manager',    userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
    ]
  },
  paldogam: {
    dates: [1, 11, 21],
    steps: [
      { role: 'settlement_owner', userId: 'U0499M26EJ2', message: '{title} 기안 등록이 완료 되었나요?' },
      { role: 'finance_lead',    userId: 'U03ABD7F9DE', message: '{title} 결재 요청 드립니다.' },
      { role: 'ceo',             userId: 'U013R34Q719', message: '{title} 결재 요청 드립니다.' },
      { role: 'accounting_manager',      userId: 'U06K3R3R6QK', message: '{title} 결재가 완료되었나요?' },
      { role: 'finance_manager',    userId: 'U044Z1AB6CT', message: '{title} 이체요청드립니다.' }
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
      Authorization: `Bearer ${CONFIG.SLACK_BOT_TOKEN}`,
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

  // ✅ 통합 API로 교체: conversations.history (페이지네이션 지원)
  async getConversationHistory(channel, limit = 100) {
    try {
      console.log(`📜 채널 메시지 조회(conversations.history): channel=${channel}, limit=${limit}`);
      const all = [];
      let cursor;

      while (all.length < limit) {
        const resp = await axios.get(`${this.baseURL}/conversations.history`, {
          headers: this.headers,
          params: {
            channel,
            limit: Math.min(200, limit - all.length),
            cursor
          }
        });

        if (!resp.data?.ok) {
          console.error('❌ conversations.history 오류:', resp.data?.error);
          return [];
        }

        const messages = resp.data.messages || [];
        all.push(...messages);

        cursor = resp.data.response_metadata?.next_cursor;
        if (!cursor) break;
      }

      console.log(`✅ conversations.history 성공: ${all.length}개 메시지`);
      return all;
    } catch (err) {
      console.error('❌ getConversationHistory 실패:', err.message);
      return [];
    }
  }

  // ✅ 스레드 답글 조회: conversations.replies
  async getThreadReplies(channel, thread_ts, limit = 100) {
    try {
      const resp = await axios.get(`${this.baseURL}/conversations.replies`, {
        headers: this.headers,
        params: { channel, ts: thread_ts, limit }
      });
      if (!resp.data?.ok) {
        console.error('❌ conversations.replies 오류:', resp.data?.error);
        return [];
      }
      return resp.data.messages || [];
    } catch (err) {
      console.error('❌ getThreadReplies 실패:', err.message);
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
      // ✅ 이미 보낸 알림이 있는지 확인
      const alreadySent = await checkExistingAlert('queenit', currentMonth, channelId);
      if (alreadySent) {
        console.log(`✅ Queenit ${currentDay}일 정산 알림이 이미 존재함 - 건너뜀`);
      } else {
        console.log(`✅ Queenit ${currentDay}일 정산일 - 첫 알림 발송`);
        await sendFirstApprovalAlert('queenit', currentMonth, currentDay, channelId);
        alertsSent++;
      }
    } else {
      console.log(`📌 Queenit: 오늘(${currentDay}일)은 정산일이 아님 - 미완료 건 확인`);
      const reminded = await remindIncompleteSettlements('queenit', currentMonth, channelId);
      alertsSent += reminded;
    }

    // ============================================
    // Paldogam 정산 확인
    // ============================================
    console.log('\n🔍 Paldogam 정산 확인');
    if (APPROVAL_FLOW.paldogam.dates.includes(currentDay)) {
      // ✅ 이미 보낸 알림이 있는지 확인
      const alreadySent = await checkExistingAlert('paldogam', currentMonth, channelId);
      if (alreadySent) {
        console.log(`✅ Paldogam ${currentDay}일 정산 알림이 이미 존재함 - 건너뜀`);
      } else {
        console.log(`✅ Paldogam ${currentDay}일 정산일 - 첫 알림 발송`);
        await sendFirstApprovalAlert('paldogam', currentMonth, currentDay, channelId);
        alertsSent++;
      }
    } else {
      console.log(`📌 Paldogam: 오늘(${currentDay}일)은 정산일이 아님 - 미완료 건 확인`);
      const reminded = await remindIncompleteSettlements('paldogam', currentMonth, channelId);
      alertsSent += reminded;
    }

    // ============================================
    // 그룹웨어 마감 워크플로우 (라포랩스, 라포스튜디오)
    // ============================================
    const groupwareAlerts = await processGroupwareDeadlines(today, channelId);
    alertsSent += groupwareAlerts;

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
// 이미 발송된 정산 알림이 있는지 확인
// ============================================
async function checkExistingAlert(platform, month, channelId) {
  const messages = await slack.getConversationHistory(channelId, 50); // 최근 50개만 확인해도 충분
  
  for (const msg of messages) {
    const text = msg.text || '';
    const blockText = (msg.blocks || [])
      .flatMap(b => (b.text?.text ? [b.text.text] : []))
      .join(' ');

    const content = `${text}\n${blockText}`;
    
    // 조건: 플랫폼 이름 + N월 + 버튼 존재
    // (완료된 건 '✅'도 포함해서 체크해야 함. 이미 완료된 건이 있으면 알림을 또 보내면 안 되므로)
    const hasButton = (msg.blocks || []).some(
      b => b.type === 'actions' && b.elements?.some(el => el.action_id === 'settlement_approve_button')
    );
    
    // ✅ 주의: 텍스트 매칭 시 '11월' 같은 월 정보도 일치해야 함
    if (content.includes(platform) && content.includes(`${month}월`) && hasButton) {
      console.log(`📌 기존 알림 발견: ${msg.ts}`);
      return true;
    }
  }
  return false;
}

// ============================================
// 첫 번째 승인 알림 발송
// ============================================
async function sendFirstApprovalAlert(platform, month, day, channelId) {
  const flow = APPROVAL_FLOW[platform];
  const firstStep = flow.steps[0];
  const title = getSettlementTitle(platform, day, month);

  const message = `<@${firstStep.userId}>님 ${firstStep.message.replace('{title}', title)}`;

  const payload = {
    // ✅ 검색/필터 안정화를 위해 text 동시 포함
    text: message,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: message }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '완료' },
            value: JSON.stringify({ platform, step: 0, month, day, title }),
            action_id: 'settlement_approve_button'
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
// 미완료 건 리마인드 (스레드로 멘션)
// - 동일 스레드에 최근 N시간 내 리마인드가 있으면 중복 전송 방지
// ============================================
// ============================================
// 해당 주에 공휴일이 포함되어 있는지 확인
// ============================================
function hasHolidayInWeek(date) {
  const day = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - day + (day === 0 ? -6 : 1));

  for (let i = 0; i < 7; i++) {
    const checkDate = new Date(monday);
    checkDate.setDate(monday.getDate() + i);
    if (isHoliday(checkDate)) {
      console.log(`🎌 ${formatDate(checkDate)}이 공휴일 - 해당 주 스킵 대상`);
      return true;
    }
  }
  return false;
}

// ============================================
// 날짜 문자열을 ISO 주차로 변환
// ============================================
function dateStringToWeek(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return getISOWeek(date);
}

// ============================================
// 그룹웨어 마감 워크플로우 - 트리거 여부 확인
// ============================================
function shouldTriggerGroupwareDeadline(companyConfig, today, commonConfig) {
  const currentWeek = getISOWeek(today);
  const currentDayOfWeek = today.getDay();
  const todayStr = formatDate(today);
  const defaultDay = companyConfig.defaultDayOfWeek;

  console.log(`📅 오늘: ${todayStr}, 주차: ${currentWeek}, 요일: ${currentDayOfWeek}`);

  // 1. 날짜 기반 예외 스케줄 확인
  for (const [exceptionDate, action] of Object.entries(companyConfig.exceptions || {})) {
    const exceptionWeek = dateStringToWeek(exceptionDate);

    if (exceptionWeek === currentWeek) {
      // 이번 주에 예외가 설정됨
      if (action === null) {
        console.log(`⏭️ ${companyConfig.name}: ${exceptionDate} 설정으로 이번 주 스킵`);
        return false;
      }

      if (typeof action === 'number') {
        // 요일 변경
        const shouldTrigger = currentDayOfWeek === action;
        console.log(`🔄 ${companyConfig.name}: 이번 주는 요일 ${action}로 변경 (트리거: ${shouldTrigger})`);
        return shouldTrigger;
      }

      if (typeof action === 'string') {
        // 특정 날짜로 변경
        const shouldTrigger = todayStr === action;
        console.log(`📆 ${companyConfig.name}: 이번 주는 ${action}로 변경 (트리거: ${shouldTrigger})`);
        return shouldTrigger;
      }
    }
  }

  // 2. 공휴일 자동 감지 (공통 설정)
  if (commonConfig?.skipHolidayWeeks && hasHolidayInWeek(today)) {
    console.log(`🎌 ${companyConfig.name}: 공휴일 주간 - 자동 스킵`);
    return false;
  }

  // 3. 기본 요일이 공휴일인 경우 대체 요일로 자동 이동
  if (commonConfig?.autoShiftOnHoliday && currentDayOfWeek === defaultDay) {
    const defaultDayDate = new Date(today);
    if (isHoliday(defaultDayDate)) {
      console.log(`🔄 ${companyConfig.name}: 목요일이 공휴일 - 대체 요일 ${commonConfig.fallbackDayOfWeek}로 이동`);
      return false; // 오늘은 트리거 안함 (대체 요일에 트리거)
    }
  }

  // 대체 요일 체크 (기본 요일이 공휴일인 경우)
  if (commonConfig?.autoShiftOnHoliday && currentDayOfWeek === commonConfig.fallbackDayOfWeek) {
    // 이번 주 목요일이 공휴일인지 확인
    const thursdayDate = new Date(today);
    const diff = defaultDay - currentDayOfWeek;
    thursdayDate.setDate(today.getDate() + diff);

    if (isHoliday(thursdayDate)) {
      console.log(`✅ ${companyConfig.name}: 목요일(${formatDate(thursdayDate)})이 공휴일 - 오늘(${currentDayOfWeek}) 대체 트리거`);
      return true;
    }
  }

  // 4. 기본 요일 체크
  const shouldTrigger = currentDayOfWeek === defaultDay;
  console.log(`📌 ${companyConfig.name}: 기본 요일 ${defaultDay} 체크 (현재: ${currentDayOfWeek}, 트리거: ${shouldTrigger})`);
  return shouldTrigger;
}

// ============================================
// 그룹웨어 마감 알림 발송
// ============================================
async function sendGroupwareDeadlineAlert(companyKey, companyConfig, channelId) {
  const ownerMentions = companyConfig.owners.map(id => `<@${id}>`).join(', ');
  const message = `${ownerMentions}님 ${companyConfig.name} 그룹웨어 마감이 완료되었다면 마감완료 버튼을 눌러주세요.`;

  const payload = {
    text: message,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: message }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '마감완료' },
            style: 'primary',
            value: JSON.stringify({
              type: 'groupware_deadline',
              company: companyKey,
              companyName: companyConfig.name,
              transferManager: companyConfig.transferManager,
              allowedUsers: companyConfig.owners
            }),
            action_id: 'groupware_deadline_button'
          }
        ]
      }
    ]
  };

  const result = await slack.postMessage(channelId, payload);

  if (result) {
    console.log(`✅ ${companyConfig.name} 그룹웨어 마감 알림 발송 성공`);
    return true;
  } else {
    console.error(`❌ ${companyConfig.name} 그룹웨어 마감 알림 발송 실패`);
    return false;
  }
}

// ============================================
// 그룹웨어 마감 알림 이미 발송 여부 확인
// ============================================
async function checkExistingGroupwareAlert(companyKey, channelId, today) {
  const messages = await slack.getConversationHistory(channelId, 50);
  const todayStr = formatDate(today);

  for (const msg of messages) {
    // 오늘 발송된 메시지만 확인
    const msgDate = new Date(parseFloat(msg.ts) * 1000);
    const msgDateStr = formatDate(msgDate);
    if (msgDateStr !== todayStr) continue;

    // 그룹웨어 마감 버튼이 있는지 확인
    const hasButton = (msg.blocks || []).some(
      b => b.type === 'actions' && b.elements?.some(el => {
        if (el.action_id !== 'groupware_deadline_button') return false;
        try {
          const data = JSON.parse(el.value);
          return data.company === companyKey;
        } catch {
          return false;
        }
      })
    );

    if (hasButton) {
      console.log(`📌 ${companyKey} 오늘 이미 알림 발송됨: ${msg.ts}`);
      return true;
    }
  }
  return false;
}

// ============================================
// 그룹웨어 마감 처리 메인 함수
// ============================================
async function processGroupwareDeadlines(today, channelId) {
  console.log('\n🏢 그룹웨어 마감 워크플로우 처리 시작');

  const groupwareConfig = CONFIG.GROUPWARE_DEADLINE;
  if (!groupwareConfig) {
    console.log('⚠️ 그룹웨어 마감 설정이 없습니다');
    return 0;
  }

  const commonConfig = groupwareConfig.common || {};
  let alertsSent = 0;

  for (const [companyKey, companyConfig] of Object.entries(groupwareConfig)) {
    // common 설정은 회사가 아니므로 스킵
    if (companyKey === 'common') continue;

    console.log(`\n🔍 ${companyConfig.name} 확인 중...`);

    // 트리거 여부 확인
    if (!shouldTriggerGroupwareDeadline(companyConfig, today, commonConfig)) {
      console.log(`⏭️ ${companyConfig.name}: 오늘은 트리거 날짜가 아님`);
      continue;
    }

    // 이미 발송 여부 확인
    const targetChannelId = channelId || companyConfig.channelId;
    const alreadySent = await checkExistingGroupwareAlert(companyKey, targetChannelId, today);
    if (alreadySent) {
      console.log(`✅ ${companyConfig.name}: 오늘 이미 알림 발송됨 - 건너뜀`);
      continue;
    }

    // 알림 발송
    const sent = await sendGroupwareDeadlineAlert(companyKey, companyConfig, targetChannelId);
    if (sent) alertsSent++;
  }

  console.log(`\n📊 그룹웨어 마감: ${alertsSent}건 처리`);
  return alertsSent;
}

async function remindIncompleteSettlements(platform, month, channelId) {
  console.log(`\n📋 ${platform} ${month}월 미완료 건 확인 시작`);

  // 채널 메시지 조회
  const messages = await slack.getConversationHistory(channelId, 200);

  if (messages.length === 0) {
    console.log('📌 조회된 메시지 없음');
    return 0;
  }

  // 미완료 건 찾기
  const incompleteSettlements = [];
  for (const msg of messages) {
    const text = msg.text || '';
    const blockText = (msg.blocks || [])
      .flatMap(b => (b.text?.text ? [b.text.text] : []))
      .join(' ');

    const searchable = `${text}\n${blockText}`;

    // 완료 공지(예: '✅ ...')는 스킵
    if (text.startsWith('✅')) continue;

    // 우리 메시지인지 식별: 플랫폼/월 키워드 + 버튼 존재
    const hasButton = (msg.blocks || []).some(
      b => b.type === 'actions' && b.elements?.some(el => el.action_id === 'settlement_approve_button')
    );
    const isTarget = searchable.includes(platform) && searchable.includes(`${month}월`);

    if (isTarget && hasButton) {
      incompleteSettlements.push(msg);
      console.log(`📌 미완료 건 발견: ts=${msg.ts}`);
    }
  }

  if (incompleteSettlements.length === 0) {
    console.log(`✅ ${platform} ${month}월 미완료 건 없음`);
    return 0;
  }

  const now = Date.now();
  const REMINDER_COOLDOWN_HOURS = 12; // 최근 12시간 내 리마인드가 있으면 중복 방지
  const cooldownMs = REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000;

  let reminded = 0;

  for (const settlement of incompleteSettlements) {
    // 현재 완료되지 않은 단계 담당자 파악
    let currentStep = 0;
    let userToRemind = null;

    const actionBlock = (settlement.blocks || []).find(b => b.type === 'actions');
    const firstEl = actionBlock?.elements?.[0];
    if (firstEl?.value) {
      try {
        const actionData = JSON.parse(firstEl.value);
        currentStep = actionData.step;
        const flow = APPROVAL_FLOW[platform];
        if (flow && flow.steps[currentStep]) {
          userToRemind = flow.steps[currentStep].userId;
        }
      } catch {
        console.warn('⚠️ 버튼 데이터 파싱 실패');
      }
    }

    if (!userToRemind) continue;

    // 스레드 내 최근 리마인드 여부 체크
    const replies = await slack.getThreadReplies(channelId, settlement.ts, 100);
    const hasRecentReminder = replies.some(r => {
      const txt = (r.text || '').trim();
      const isOurReminder = txt.startsWith('⏰ *리마인더*');
      if (!isOurReminder) return false;
      const tsMs = Math.floor(parseFloat(r.ts) * 1000);
      return now - tsMs < cooldownMs;
    });

    if (hasRecentReminder) {
      console.log(`⏳ 최근 ${REMINDER_COOLDOWN_HOURS}시간 이내 리마인드 존재 → 건너뜀 (ts=${settlement.ts})`);
      continue;
    }

    const reminderMsg =
      `⏰ *리마인더* <@${userToRemind}>님, ${platform} ${month}월 정산건이 아직 완료되지 않았습니다. 확인 부탁드립니다.\n` +
      `시간: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`;

    const result = await slack.postMessage(channelId, {
      thread_ts: settlement.ts,
      text: reminderMsg
    });

    if (result) {
      console.log(`✅ 리마인더 메시지 발송: user=${userToRemind}, thread_ts=${settlement.ts}`);
      reminded++;
    }
  }

  console.log(`📊 ${platform} ${month}월: ${reminded}건 리마인드`);
  return reminded;
}
