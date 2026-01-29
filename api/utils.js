// api/utils.js

// ============================================
// 날짜 유틸
// ============================================

/**
 * 시간 제거 (자정으로 설정)
 */
function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 두 날짜가 같은 날인지 확인
 */
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/**
 * 주말 확인 (토요일=6, 일요일=0)
 */
function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

/**
 * 공휴일 확인
 */
function isHoliday(d) {
  const holidays = [
    // 2025년 공휴일
    new Date(2025, 0, 1),    // 신정
    new Date(2025, 1, 12),   // 설날 연휴
    new Date(2025, 1, 13),   // 설날
    new Date(2025, 2, 1),    // 삼일절
    new Date(2025, 3, 5),    // 어린이날
    new Date(2025, 4, 5),    // 입춘
    new Date(2025, 4, 15),   // 부처님 오신 날
    new Date(2025, 5, 6),    // 현충일
    new Date(2025, 7, 15),   // 광복절
    new Date(2025, 8, 16),   // 추석 연휴
    new Date(2025, 8, 17),   // 추석
    new Date(2025, 8, 18),   // 추석 연휴
    new Date(2025, 9, 3),    // 개교기념일
    new Date(2025, 9, 9),    // 한글날
    new Date(2025, 11, 25),  // 크리스마스

    // 2026년 공휴일
    new Date(2026, 0, 1),    // 신정
    new Date(2026, 1, 9),    // 설날 연휴
    new Date(2026, 1, 10),   // 설날
    new Date(2026, 1, 11),   // 설날 연휴
    new Date(2026, 2, 1),    // 삼일절
    new Date(2026, 3, 5),    // 어린이날
    new Date(2026, 4, 5),    // 입춘
    new Date(2026, 4, 6),    // 대체공휴일
    new Date(2026, 5, 6),    // 현충일
    new Date(2026, 7, 15),   // 광복절
    new Date(2026, 8, 4),    // 추석 연휴
    new Date(2026, 8, 5),    // 추석
    new Date(2026, 8, 6),    // 추석 연휴
    new Date(2026, 9, 3),    // 개교기념일
    new Date(2026, 9, 9),    // 한글날
    new Date(2026, 11, 25)   // 크리스마스
  ];

  return holidays.some(h =>
    h.getFullYear() === d.getFullYear() &&
    h.getMonth() === d.getMonth() &&
    h.getDate() === d.getDate()
  );
}

/**
 * 주말 또는 공휴일 확인
 */
function isHolidayOrWeekend(d) {
  return isWeekend(d) || isHoliday(d);
}

// ============================================
// 영업일 계산
// ============================================

/**
 * 영업일 더하기/빼기
 * @param {Date} date - 시작 날짜
 * @param {number} days - 더할 영업일 수 (음수면 빼기)
 */
function addBusinessDays(date, days) {
  let cur = new Date(date);
  let cnt = 0;
  const dir = days > 0 ? 1 : -1;
  const abs = Math.abs(days);

  while (cnt < abs) {
    cur.setDate(cur.getDate() + dir);
    if (!isHolidayOrWeekend(cur)) cnt++;
  }

  return stripTime(cur);
}

/**
 * 이전 영업일 찾기
 */
function getPreviousBusinessDay(date) {
  let d = new Date(date);
  d.setDate(d.getDate() - 1);

  while (isHolidayOrWeekend(d)) {
    d.setDate(d.getDate() - 1);
  }

  return stripTime(d);
}

/**
 * 다음 영업일 찾기
 */
function getNextBusinessDay(date) {
  let d = new Date(date);
  d.setDate(d.getDate() + 1);

  while (isHolidayOrWeekend(d)) {
    d.setDate(d.getDate() + 1);
  }

  return stripTime(d);
}

// ============================================
// 시간 파싱
// ============================================

/**
 * 오늘 날짜에서 특정 시간의 Date 객체 생성
 * @param {Date} todayDate - 날짜
 * @param {string} hhmm - 시간 (예: "09:00")
 */
function parseTodayTime(todayDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(todayDate);
  d.setHours(h);
  d.setMinutes(m);
  d.setSeconds(0);
  d.setMilliseconds(0);
  return d;
}

/**
 * 마지막 리마인드 시간 이후에 리마인드했는지 확인
 */
function hasRemindedAfter(last, target) {
  if (!last) return false;
  // 어제 이전 알림은 무시
  if (stripTime(last).getTime() < stripTime(target).getTime()) return false;
  return last.getTime() >= target.getTime();
}

// ============================================
// 포맷팅
// ============================================

/**
 * ISO 주차 계산 (YYYY-WW 형식 반환)
 * @param {Date} date - 날짜
 * @returns {string} - "YYYY-WW" 형식 (예: "2025-05")
 */
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

/**
 * 날짜를 "YYYY-MM-DD" 형식으로 포맷
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 날짜를 "YYYY-MM-DD HH:mm:ss" 형식으로 포맷
 */
function formatDateTime(date) {
  const dateStr = formatDate(date);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${dateStr} ${hours}:${minutes}:${seconds}`;
}

// ============================================
// 내보내기
// ============================================

module.exports = {
  // 날짜
  stripTime,
  isSameDay,
  isWeekend,
  isHoliday,
  isHolidayOrWeekend,

  // 영업일
  addBusinessDays,
  getPreviousBusinessDay,
  getNextBusinessDay,

  // 시간
  parseTodayTime,
  hasRemindedAfter,

  // 포맷팅
  formatDate,
  formatDateTime,
  getISOWeek
};