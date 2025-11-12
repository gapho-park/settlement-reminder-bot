from guidelines_loader import GuidelinesLoader
import os
import json
import asyncio
from io import BytesIO
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional
from collections import defaultdict
import time
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import httpx
from slack_bolt import App
import PyPDF2
from anthropic import Anthropic

# ==================== 시간대 설정 ====================
KST = timezone(timedelta(hours=9))

def get_kst_now() -> datetime:
    """현재 한국 시간 반환"""
    return datetime.now(KST)

def format_kst_timestamp() -> str:
    """한국 시간 타임스탬프 문자열 반환"""
    return get_kst_now().strftime("%Y-%m-%d %H:%M:%S")

from workflow_config import (
    get_workflow_config, 
    get_action_status, 
    format_notification_message,
    format_response_message,
    RESPONSE_MESSAGES,
    get_review_result_workflow,
    get_next_step_message,
    create_action_blocks_with_branching,
    get_report_template,
    get_claude_system_prompt_with_template
)

from email_config import (
    create_email_body,
    get_law_firm_recipients
)
from report_formatter import (
    format_report_for_slack,
    extract_summary_from_analysis,
    enrich_analysis_data,
    validate_report_format,
    chunk_report_for_slack
)

# ==================== 초기화 ====================
app_fastapi = FastAPI()

# Slack 설정
SLACK_BOT_TOKEN = os.getenv("SLACK_BOT_TOKEN")
SLACK_SIGNING_SECRET = os.getenv("SLACK_SIGNING_SECRET")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY")
NOTION_TOKEN = os.getenv("NOTION_TOKEN")
NOTION_GUIDELINES_PAGE_ID = os.getenv("NOTION_GUIDELINES_PAGE_ID")

# Google Sheets 설정
SHEETS_SPREADSHEET_ID = os.getenv("SHEETS_SPREADSHEET_ID", "1LgDjWbjVS4g0EmADvBTlOj9nKbYE4xBMC3oF5iKGQRo")
SHEETS_NAME = "시트1"

# 재무팀 그룹 ID
FINANCE_TEAM_GROUP_ID = "S02DE0TQ2CV"

slack_app = App(token=SLACK_BOT_TOKEN, signing_secret=SLACK_SIGNING_SECRET)
claude_client = Anthropic(api_key=CLAUDE_API_KEY)
guidelines_loader = GuidelinesLoader("guidelines.json")

# ==================== 유틸리티 함수 ====================

def get_user_real_name(client, user_id: str) -> str:
    """Slack 유저 ID를 실제 이름으로 변환"""
    try:
        user_info = client.users_info(user=user_id)
        if user_info.get("ok"):
            user = user_info.get("user", {})
            real_name = user.get("profile", {}).get("real_name")
            display_name = user.get("profile", {}).get("display_name")
            return real_name or display_name or user_id
        return user_id
    except Exception as e:
        print(f"⚠️ 사용자 이름 조회 실패: {e}")
        return user_id

def get_user_email_from_slack(client, user_id: str) -> str:
    """Slack 프로필에서 이메일 주소 가져오기"""
    try:
        user_info = client.users_info(user=user_id)
        if user_info.get("ok"):
            email = user_info.get("user", {}).get("profile", {}).get("email")
            return email if email else f"unknown_{user_id}@rapportlabs.kr"
    except Exception as e:
        print(f"⚠️ Slack 이메일 조회 실패: {e}")
    return f"unknown_{user_id}@rapportlabs.kr"

def is_main_contract_file(filename: str) -> bool:
    """원계약서 파일 판별"""
    keywords = ["계약서", "contract", "agreement", "main"]
    addon_keywords = ["부속", "addendum", "amendment", "supplement"]
    
    filename_lower = filename.lower()
    has_contract = any(kw in filename_lower for kw in keywords)
    has_addon = any(kw in filename_lower for kw in addon_keywords)
    
    return has_contract and not has_addon

def is_addendum_file(filename: str) -> bool:
    """부속합의서 파일 판별"""
    keywords = ["부속", "addendum", "amendment", "supplement", "별지", "첨부"]
    return any(kw in filename.lower() for kw in keywords)

# ==================== 중복 처리 방지 ====================

class ProcessedThreadsTracker:
    """스레드 단위로 처리 중복 방지"""
    def __init__(self, window_seconds=600):
        self.window = window_seconds
        self.threads = {}
    
    def is_processing(self, channel_id: str, thread_ts: str) -> bool:
        """현재 처리 중인지 확인"""
        thread_key = f"{channel_id}_{thread_ts}"
        current_time = time.time()
        
        expired_keys = [k for k, (t, _) in self.threads.items() 
                       if current_time - t > self.window]
        for k in expired_keys:
            del self.threads[k]
        
        if thread_key in self.threads:
            _, status = self.threads[thread_key]
            return status == "processing"
        return False
    
    def mark_processing(self, channel_id: str, thread_ts: str):
        """처리 시작 표시"""
        thread_key = f"{channel_id}_{thread_ts}"
        self.threads[thread_key] = (time.time(), "processing")
        print(f"📝 처리 시작 표시: {thread_key}")
    
    def mark_completed(self, channel_id: str, thread_ts: str):
        """처리 완료 표시"""
        thread_key = f"{channel_id}_{thread_ts}"
        if thread_key in self.threads:
            self.threads[thread_key] = (time.time(), "completed")
            print(f"✅ 처리 완료 표시: {thread_key}")

processed_threads_tracker = ProcessedThreadsTracker(window_seconds=600)

# ==================== Notion 캐싱 ====================

class NotionCache:
    """Notion API 응답 캐싱"""
    def __init__(self, ttl_seconds=3600):
        self.cache = {}
        self.ttl = ttl_seconds
    
    def get(self, page_id: str) -> Optional[str]:
        """캐시에서 가져오기"""
        if page_id in self.cache:
            cached_time, content = self.cache[page_id]
            if time.time() - cached_time < self.ttl:
                print(f"✅ Notion 캐시 히트: {page_id}")
                return content
            else:
                del self.cache[page_id]
        return None
    
    def set(self, page_id: str, content: str):
        """캐시에 저장"""
        self.cache[page_id] = (time.time(), content)
        print(f"💾 Notion 캐시 저장: {page_id}")

notion_cache = NotionCache(ttl_seconds=3600)

# ==================== 분석 데이터 캐시 ====================
document_analysis_cache = {}

# ==================== Google Sheets 저장 ====================

async def save_to_google_sheets(review_data: Dict[str, Any]) -> bool:
    """검토 이력을 Google Sheets에 저장"""
    try:
        print(f"📊 Google Sheets에 저장 중... {review_data.get('filename')}")
        
        risk_level = review_data.get("risk_level", "MEDIUM")
        template = get_report_template(risk_level)
        
        summary = review_data.get("summary", "")
        if template["detail_level"] == "brief":
            summary_truncate = summary[:150]
        elif template["detail_level"] == "moderate":
            summary_truncate = summary[:200]
        else:
            summary_truncate = summary[:300]
        
        row_data = [
            review_data.get("analysis_timestamp", format_kst_timestamp()),
            review_data.get("filename", ""),
            review_data.get("file_id", ""),
            review_data.get("uploader", ""),
            review_data.get("channel_id", ""),
            review_data.get("thread_ts", ""),
            review_data.get("slack_link", ""),
            risk_level,
            review_data.get("document_type", "기타"),
            ", ".join(review_data.get("applicable_laws", [])),
            ", ".join(review_data.get("risk_factors", [])),
            ", ".join(review_data.get("keywords", [])),
            review_data.get("contract_amount", ""),
            review_data.get("contract_period", ""),
            review_data.get("counterparty", ""),
            review_data.get("status", "대기중"),
            "TRUE" if review_data.get("external_review_needed") else "FALSE",
            review_data.get("approver", ""),
            review_data.get("approval_timestamp", ""),
            review_data.get("ai_accuracy", ""),
            review_data.get("actual_risk_level", ""),
            review_data.get("feedback_content", ""),
            review_data.get("feedback_submitter", ""),
            review_data.get("feedback_timestamp", ""),
            summary_truncate,
            review_data.get("slack_link", ""),
            template["detail_level"],
        ]
        
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        
        creds_json = os.getenv("GOOGLE_SHEETS_CREDENTIALS")
        if not creds_json:
            print("⚠️ GOOGLE_SHEETS_CREDENTIALS 환경변수가 없습니다")
            return False
        
        creds_dict = json.loads(creds_json)
        creds = service_account.Credentials.from_service_account_info(
            creds_dict,
            scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
        
        service = build('sheets', 'v4', credentials=creds)
        
        body = {'values': [row_data]}
        
        result = service.spreadsheets().values().append(
            spreadsheetId=SHEETS_SPREADSHEET_ID,
            range=f'{SHEETS_NAME}!A:Z',
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body=body
        ).execute()
        
        print(f"✅ Google Sheets 저장 완료! {result.get('updates', {}).get('updatedRows', 0)}행 추가")
        return True
        
    except Exception as e:
        print(f"❌ Google Sheets 저장 오류: {e}")
        import traceback
        traceback.print_exc()
        return False

# ==================== Notion 가이드라인 ====================

async def get_notion_page_content(page_id: str) -> str:
    """Notion 페이지 내용 가져오기"""
    cached_content = notion_cache.get(page_id)
    if cached_content:
        return cached_content
    
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }
    
    async with httpx.AsyncClient() as client:
        try:
            blocks_response = await client.get(
                f"https://api.notion.com/v1/blocks/{page_id}/children?page_size=100",
                headers=headers,
                timeout=10.0
            )
            blocks_response.raise_for_status()
            blocks = blocks_response.json()["results"]
            
            content = []
            for block in blocks:
                if block["type"] == "paragraph":
                    text = block["paragraph"]["rich_text"]
                    if text:
                        content.append("".join([t["plain_text"] for t in text]))
                elif block["type"] == "heading_1":
                    text = block["heading_1"]["rich_text"]
                    if text:
                        content.append(f"# {' '.join([t['plain_text'] for t in text])}")
                elif block["type"] == "heading_2":
                    text = block["heading_2"]["rich_text"]
                    if text:
                        content.append(f"## {' '.join([t['plain_text'] for t in text])}")
                elif block["type"] == "heading_3":
                    text = block["heading_3"]["rich_text"]
                    if text:
                        content.append(f"### {' '.join([t['plain_text'] for t in text])}")
                elif block["type"] == "bulleted_list_item":
                    text = block["bulleted_list_item"]["rich_text"]
                    if text:
                        content.append(f"- {' '.join([t['plain_text'] for t in text])}")
                elif block["type"] == "numbered_list_item":
                    text = block["numbered_list_item"]["rich_text"]
                    if text:
                        content.append(f"1. {' '.join([t['plain_text'] for t in text])}")
            
            result = "\n".join(content)
            notion_cache.set(page_id, result)
            return result
            
        except Exception as e:
            print(f"❌ Notion 오류: {e}")
            raise ValueError(f"Notion 가이드라인 로드 실패: {str(e)}")

# ==================== 문서 처리 ====================

async def extract_document_text(file_url: str, bot_token: str, filename: str) -> str:
    """Slack 파일 URL에서 문서 텍스트 추출"""
    headers = {"Authorization": f"Bearer {bot_token}"}
    
    async with httpx.AsyncClient() as client:
        response = await client.get(file_url, headers=headers, timeout=30.0)
        response.raise_for_status()
        
        file_content = response.content
        file_lower = filename.lower()
        
        if file_lower.endswith('.pdf'):
            return await extract_pdf_text(file_content)
        elif file_lower.endswith('.docx'):
            return await extract_docx_text(file_content)
        elif file_lower.endswith('.doc'):
            return await extract_docx_text(file_content)
        else:
            raise ValueError(f"지원하지 않는 파일 형식: {filename}")

async def extract_pdf_text(file_content: bytes) -> str:
    """PDF 텍스트 추출"""
    try:
        pdf_file = BytesIO(file_content)
        pdf_reader = PyPDF2.PdfReader(pdf_file)
        text = ""
        
        for page in pdf_reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
        
        if len(text.strip()) < 100:
            raise ValueError("이 PDF는 스캔된 이미지로 구성되어 텍스트를 추출할 수 없습니다.")
        
        print(f"✅ PDF 텍스트 추출 성공 ({len(text)}자)")
        return text.strip()
        
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"PDF 처리 오류: {str(e)}")

async def extract_docx_text(file_content: bytes) -> str:
    """DOCX/DOC 텍스트 추출"""
    try:
        import docx
        
        docx_file = BytesIO(file_content)
        doc = docx.Document(docx_file)
        
        text = ""
        for paragraph in doc.paragraphs:
            if paragraph.text.strip():
                text += paragraph.text + "\n"
        
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    if cell.text.strip():
                        text += cell.text + " "
                text += "\n"
        
        if not text.strip():
            raise ValueError("문서에서 텍스트를 추출할 수 없습니다")
        
        return text.strip()
    except ImportError:
        raise ValueError("python-docx 라이브러리가 필요합니다.")
    except Exception as e:
        raise ValueError(f"문서 처리 오류: {str(e)}")

# ==================== 파일 조회 ====================

def get_all_files_in_thread(client, channel_id: str, thread_ts: str) -> list:
    """스레드의 모든 파일 조회"""
    try:
        print(f"🔍 스레드에서 파일 조회 중: {channel_id}/{thread_ts}")
        
        history = client.conversations_replies(
            channel=channel_id,
            ts=thread_ts,
            limit=100
        )
        
        files = []
        for msg in history.get("messages", []):
            for file_obj in msg.get("files", []):
                file_info = {
                    "id": file_obj.get("id"),
                    "name": file_obj.get("name"),
                    "url_private": file_obj.get("url_private")
                }
                files.append(file_info)
                print(f"  ✅ 파일 발견: {file_info['name']}")
        
        print(f"📊 총 {len(files)}개 파일 발견")
        return files
    except Exception as e:
        print(f"❌ 파일 조회 오류: {e}")
        return []

def find_file_message_timestamp(client, channel_id: str, file_id: str) -> Optional[str]:
    """파일이 업로드된 메시지의 타임스탬프 찾기"""
    try:
        print(f"🔍 파일 {file_id} 메시지 검색 중...")
        
        file_info = client.files_info(file=file_id)
        file_obj = file_info["file"]
        
        shares = file_obj.get("shares", {})
        if shares:
            for share_type in ["public", "private"]:
                if share_type in shares:
                    channel_shares = shares[share_type].get(channel_id, [])
                    if channel_shares and len(channel_shares) > 0:
                        ts = channel_shares[0].get("ts")
                        if ts:
                            print(f"✅ 타임스탬프 발견: {ts}")
                            return ts
        
        history = client.conversations_history(channel=channel_id, limit=30)
        
        if history.get("ok"):
            for message in history.get("messages", []):
                for file_obj_in_msg in message.get("files", []):
                    if file_obj_in_msg.get("id") == file_id:
                        ts = message.get("ts")
                        print(f"✅ 타임스탬프 발견: {ts}")
                        return ts
        
        return None
        
    except Exception as e:
        print(f"❌ 타임스탬프 검색 오류: {e}")
        return None

# ==================== 다중 파일 처리 ====================

async def process_multiple_files(all_files: list, channel_id: str, thread_ts: str, 
                                 user_id: str, client):
    """여러 파일을 함께 분석"""
    try:
        print(f"🔗 {len(all_files)}개 파일 통합 분석 시작")
        
        all_texts = {}
        for file_obj in all_files:
            try:
                doc_text = await extract_document_text(
                    file_obj["url_private"],
                    SLACK_BOT_TOKEN,
                    file_obj["name"]
                )
                all_texts[file_obj["name"]] = doc_text
                print(f"✅ {file_obj['name']} 추출 완료")
            except Exception as e:
                print(f"❌ {file_obj['name']} 추출 실패: {e}")
                continue
        
        if not all_texts:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text="❌ 처리 가능한 파일이 없습니다.",
                mrkdwn=True
            )
            return
        
        print("📖 가이드라인 로드 중...")
        try:
            guidelines = guidelines_loader.get_full_guidelines()
        except ValueError as e:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=f"❌ {str(e)}",
                mrkdwn=True
            )
            return
        
        combined_text = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n".join(
            [f"[{filename}]\n{text}" for filename, text in all_texts.items()]
        )
        
        enhanced_guidelines = guidelines + f"""

## ⭐ 다중 문서 검토 특별 지침
이 요청에는 {len(all_texts)}개의 관련 문서가 포함되어 있습니다:
{', '.join(all_texts.keys())}

### 검토 방식:
1. 각 문서의 개별 위험도 평가
2. 원 계약서와 부속합의서의 관계성 분석
3. 통합 위험도 결정 (더 높은 위험도 적용)
4. 상호작용 리스크 평가"""
        
        print("🤖 Claude 분석 시작...")
        analysis = await analyze_document_structured(combined_text, enhanced_guidelines)
        
        main_file = all_files[0]
        slack_link = f"https://rapportlabs.slack.com/archives/{channel_id}/p{thread_ts.replace('.', '')}"
        risk_level = analysis.get("risk_level", "MEDIUM")
        
        sheets_data = {
            "analysis_timestamp": format_kst_timestamp(),
            "filename": f"{main_file['name']} + {len(all_files)-1}개 부속문서",
            "file_id": main_file["id"],
            "uploader": user_id,
            "channel_id": channel_id,
            "thread_ts": thread_ts,
            "slack_link": slack_link,
            "risk_level": risk_level,
            "document_type": analysis.get("document_type", "계약서"),
            "applicable_laws": analysis.get("applicable_laws", []),
            "risk_factors": analysis.get("risk_factors", []),
            "keywords": analysis.get("keywords", []),
            "contract_amount": analysis.get("contract_amount_usd"),
            "contract_period": analysis.get("contract_period", ""),
            "counterparty": analysis.get("counterparty", ""),
            "status": "대기중" if risk_level == "LOW" else "재무팀 검토중",
            "external_review_needed": risk_level == "HIGH",
            "summary": analysis.get("summary", "")
        }
        
        sheets_saved = await save_to_google_sheets(sheets_data)
        
        document_analysis_cache[main_file["id"]] = {
            "document_type": analysis.get("document_type", "계약서"),
            "risk_factors": analysis.get("risk_factors", []),
            "applicable_laws": analysis.get("applicable_laws", []),
            "risk_level": risk_level
        }
        
        detailed_report = analysis.get("detailed_report", "분석 결과를 불러올 수 없습니다.")
        chunks = chunk_report_for_slack(detailed_report, max_chunk_size=3000)
        
        if chunks:
            first_message = f"✅ *다중 문서 분석 완료*\n\n{chunks[0]}"
            if sheets_saved:
                sheets_link = f"https://docs.google.com/spreadsheets/d/{SHEETS_SPREADSHEET_ID}"
                first_message += f"\n\n📊 <{sheets_link}|Google Sheets에서 보기>"
            
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=first_message,
                mrkdwn=True,
                unfurl_links=False
            )
            
            for chunk in chunks[1:]:
                client.chat_postMessage(
                    channel=channel_id,
                    thread_ts=thread_ts,
                    text=chunk,
                    mrkdwn=True,
                    unfurl_links=False
                )
        
        action_message = format_notification_message(risk_level, FINANCE_TEAM_GROUP_ID)
        client.chat_postMessage(
            channel=channel_id,
            thread_ts=thread_ts,
            text=action_message,
            mrkdwn=True
        )
        
        try:
            action_blocks = create_action_blocks_with_branching(risk_level, main_file["id"])
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                blocks=action_blocks,
                mrkdwn=True
            )
        except Exception as e:
            print(f"❌ 버튼 전송 오류: {e}")
        
        print("✅ 다중 파일 처리 완료")
    
    except Exception as e:
        print(f"❌ 다중 파일 처리 오류: {e}")
        client.chat_postMessage(
            channel=channel_id,
            thread_ts=thread_ts,
            text=f"❌ 분석 중 오류 발생: {str(e)}",
            mrkdwn=True
        )

# ==================== 자동 감지 및 처리 ====================

async def auto_detect_and_process_files(file_id: str, channel_id: str, 
                                       user_id: str, client):
    """같은 스레드의 모든 파일을 감지하고 처리"""
    try:
        thread_ts = find_file_message_timestamp(client, channel_id, file_id)
        
        if not thread_ts:
            start_message = client.chat_postMessage(
                channel=channel_id,
                text="📋 법률 문서 분석 시작... (1-2분 소요)",
                mrkdwn=True
            )
            thread_ts = start_message.get("ts")
        
        if processed_threads_tracker.is_processing(channel_id, thread_ts):
            print(f"⏳ 이미 처리 중입니다: {channel_id}/{thread_ts}")
            return
        
        processed_threads_tracker.mark_processing(channel_id, thread_ts)
        
        all_files = get_all_files_in_thread(client, channel_id, thread_ts)
        
        if not all_files:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text="❌ 처리 가능한 파일을 찾을 수 없습니다.",
                mrkdwn=True
            )
            processed_threads_tracker.mark_completed(channel_id, thread_ts)
            return
        
        has_main_contract = any(is_main_contract_file(f["name"]) for f in all_files)
        has_addendum = any(is_addendum_file(f["name"]) for f in all_files)
        
        if has_addendum and not has_main_contract:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text="""⚠️ *부속합의서만 감지되었습니다*
정확한 검토를 위해 *원 계약서도 함께 업로드*해주세요.""",
                mrkdwn=True
            )
            processed_threads_tracker.mark_completed(channel_id, thread_ts)
            return
        
        if len(all_files) == 1:
            print("⏳ 1개 파일만 감지. 5초 대기...")
            await asyncio.sleep(5)
            all_files_retry = get_all_files_in_thread(client, channel_id, thread_ts)
            if len(all_files_retry) > len(all_files):
                all_files = all_files_retry
        
        if len(all_files) >= 2:
            await process_multiple_files(all_files, channel_id, thread_ts, user_id, client)
        else:
            await process_file(
                file_id=all_files[0]["id"],
                file_url=all_files[0]["url_private"],
                filename=all_files[0]["name"],
                channel_id=channel_id,
                thread_ts=thread_ts,
                user_id=user_id,
                client=client
            )
        
        processed_threads_tracker.mark_completed(channel_id, thread_ts)
    
    except Exception as e:
        print(f"❌ 파일 감지 오류: {e}")

# ==================== Claude 분석 ====================

async def analyze_document_structured(doc_text: str, guidelines: str) -> Dict[str, Any]:
    """Claude를 사용하여 법률 문서 분석"""
    
    system_prompt = f"""당신은 라포랩스(패션/농산물 e-커머스 플랫폼)의 전문 법률 검토자입니다.

## 법률검토 가이드라인
{guidelines}

---
## 검토 방식

1. 1차 스크리닝: 문서 유형 분류
2. 법령 적합성: 체크리스트 적용
3. 리스크 평가: HIGH/MEDIUM/LOW
4. 논리 일관성 검증
5. 개선 방안 제시

---
## 응답 형식 (JSON)

```json
{{
  "document_type": "계약서|협약서|기타",
  "risk_level": "HIGH|MEDIUM|LOW",
  "risk_factors": ["위험요소1", "위험요소2", "위험요소3"],
  "applicable_laws": ["법령1", "법령2"],
  "keywords": ["키워드1", "키워드2"],
  "counterparty": "상대방",
  "contract_amount_usd": 0,
  "contract_period": "YYYY-MM-DD ~ YYYY-MM-DD",
  "summary": "3줄 요약",
  "detailed_report": "Slack 마크다운 형식의 상세 보고서"
}}
```
"""

    max_retries = 5
    base_delay = 2
    
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                delay = base_delay * (attempt + 1)
                print(f"🔄 재시도 {attempt + 1}/{max_retries} (대기: {delay}초)")
                await asyncio.sleep(delay)
            
            print(f"📤 Claude API 호출 ({attempt + 1}/{max_retries})")
            
            message = claude_client.messages.create(
                model="claude-opus-4-1",
                max_tokens=4000,
                messages=[
                    {
                        "role": "user",
                        "content": f"""다음 법률 문서를 검토하고 JSON 형식으로 응답해주세요:

---
{doc_text[:15000]}
---

위 지침에 따라 구조화된 JSON으로 분석 결과를 제공해주세요."""
                    }
                ],
                system=system_prompt
            )
            
            response_text = message.content[0].text
            print(f"📥 응답 수신 (길이: {len(response_text)})")
            
            try:
                if "```json" in response_text:
                    json_str = response_text.split("```json")[1].split("```")[0].strip()
                elif "```" in response_text:
                    json_str = response_text.split("```")[1].split("```")[0].strip()
                else:
                    json_str = response_text.strip()
                
                structured_data = json.loads(json_str)
                structured_data["raw_response"] = response_text
                
                print(f"✅ 분석 성공")
                return structured_data
                
            except Exception as parse_error:
                print(f"⚠️ JSON 파싱 실패: {parse_error}")
                return {
                    "document_type": "기타",
                    "risk_level": "MEDIUM",
                    "risk_factors": [],
                    "applicable_laws": [],
                    "keywords": [],
                    "detailed_report": response_text,
                    "raw_response": response_text
                }
        
        except Exception as e:
            error_lower = str(e).lower()
            print(f"❌ 오류: {type(e).__name__}")
            
            if any(kw in error_lower for kw in ["overload", "429", "rate limit", "503"]) and attempt < max_retries - 1:
                print(f"⏳ 재시도 가능한 오류. 재시도 예정...")
                continue
            
            return {
                "document_type": "기타",
                "risk_level": "MEDIUM",
                "error": str(e),
                "detailed_report": "❌ 분석 중 오류 발생. 잠시 후 다시 시도해주세요.",
                "raw_response": ""
            }
    
    return {
        "document_type": "기타",
        "risk_level": "MEDIUM",
        "detailed_report": "❌ 최대 재시도 초과",
        "raw_response": ""
    }

# ==================== 단일 파일 처리 ====================

async def process_file(file_id: str, file_url: str, filename: str, channel_id: str, 
                      thread_ts: str, user_id: str, client):
    """단일 파일 처리"""
    try:
        print(f"📄 파일 처리: {filename}")
        
        try:
            doc_text = await extract_document_text(file_url, SLACK_BOT_TOKEN, filename)
        except ValueError as e:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=f"❌ {str(e)}",
                mrkdwn=True
            )
            return
        
        if not doc_text.strip():
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text="❌ 문서에서 텍스트를 추출할 수 없습니다.",
                mrkdwn=True
            )
            return
        
        print("📖 가이드라인 로드...")
        try:
            guidelines = guidelines_loader.get_full_guidelines()
        except ValueError as e:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=f"❌ {str(e)}",
                mrkdwn=True
            )
            return
        
        if not guidelines.strip():
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text="❌ 가이드라인을 불러올 수 없습니다.",
                mrkdwn=True
            )
            return
        
        print("🤖 Claude 분석...")
        analysis = await analyze_document_structured(doc_text, guidelines)
        
        slack_link = f"https://rapportlabs.slack.com/archives/{channel_id}/p{thread_ts.replace('.', '')}"
        risk_level = analysis.get("risk_level", "MEDIUM")
        
        sheets_data = {
            "analysis_timestamp": format_kst_timestamp(),
            "filename": filename,
            "file_id": file_id,
            "uploader": user_id,
            "channel_id": channel_id,
            "thread_ts": thread_ts,
            "slack_link": slack_link,
            "risk_level": risk_level,
            "document_type": analysis.get("document_type", "기타"),
            "applicable_laws": analysis.get("applicable_laws", []),
            "risk_factors": analysis.get("risk_factors", []),
            "keywords": analysis.get("keywords", []),
            "contract_amount": analysis.get("contract_amount_usd"),
            "contract_period": analysis.get("contract_period", ""),
            "counterparty": analysis.get("counterparty", ""),
            "status": "대기중" if risk_level == "LOW" else "재무팀 검토중",
            "external_review_needed": risk_level == "HIGH",
            "summary": analysis.get("summary", "")
        }
        
        print("📊 Sheets 저장...")
        sheets_saved = await save_to_google_sheets(sheets_data)
        
        document_analysis_cache[file_id] = {
            "document_type": analysis.get("document_type", "기타"),
            "risk_factors": analysis.get("risk_factors", []),
            "applicable_laws": analysis.get("applicable_laws", []),
            "risk_level": risk_level
        }
        
        detailed_report = analysis.get("detailed_report", "분석 결과 없음")
        chunks = chunk_report_for_slack(detailed_report, max_chunk_size=3000)
        
        if chunks:
            first_message = f"✅ *분석 완료*\n\n{chunks[0]}"
            if sheets_saved:
                sheets_link = f"https://docs.google.com/spreadsheets/d/{SHEETS_SPREADSHEET_ID}"
                first_message += f"\n\n📊 <{sheets_link}|Google Sheets>"
            
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=first_message,
                mrkdwn=True,
                unfurl_links=False
            )
            
            for chunk in chunks[1:]:
                client.chat_postMessage(
                    channel=channel_id,
                    thread_ts=thread_ts,
                    text=chunk,
                    mrkdwn=True,
                    unfurl_links=False
                )
        
        action_message = format_notification_message(risk_level, FINANCE_TEAM_GROUP_ID)
        client.chat_postMessage(
            channel=channel_id,
            thread_ts=thread_ts,
            text=action_message,
            mrkdwn=True
        )
        
        try:
            action_blocks = create_action_blocks_with_branching(risk_level, file_id)
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                blocks=action_blocks,
                mrkdwn=True
            )
        except Exception as e:
            print(f"❌ 버튼 오류: {e}")
        
        print("✅ 처리 완료")
        
    except Exception as e:
        print(f"❌ 처리 오류: {e}")
        client.chat_postMessage(
            channel=channel_id,
            thread_ts=thread_ts,
            text=f"❌ 오류: {str(e)}",
            mrkdwn=True
        )

# ==================== 상태 업데이트 ====================

async def update_document_status(file_id: str, status: str, user_id: str):
    """Google Sheets 상태 업데이트"""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        
        creds_json = os.getenv("GOOGLE_SHEETS_CREDENTIALS")
        if not creds_json:
            return
        
        creds_dict = json.loads(creds_json)
        creds = service_account.Credentials.from_service_account_info(
            creds_dict,
            scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
        
        service = build('sheets', 'v4', credentials=creds)
        
        result = service.spreadsheets().values().get(
            spreadsheetId=SHEETS_SPREADSHEET_ID,
            range=f'{SHEETS_NAME}!A:Z'
        ).execute()
        
        values = result.get('values', [])
        
        for idx, row in enumerate(values):
            if len(row) > 2 and row[2] == file_id:
                row_index = idx + 1
                timestamp = format_kst_timestamp()
                
                update_data = [
                    {'range': f'{SHEETS_NAME}!P{row_index}', 'values': [[status]]},
                    {'range': f'{SHEETS_NAME}!R{row_index}', 'values': [[user_id]]},
                    {'range': f'{SHEETS_NAME}!S{row_index}', 'values': [[timestamp]]}
                ]
                
                body = {'data': update_data, 'valueInputOption': 'USER_ENTERED'}
                service.spreadsheets().values().batchUpdate(
                    spreadsheetId=SHEETS_SPREADSHEET_ID,
                    body=body
                ).execute()
                
                print(f"✅ 상태 업데이트: {status}")
                return
                
    except Exception as e:
        print(f"❌ 상태 업데이트 오류: {e}")

# ==================== 액션 핸들러 ====================

async def handle_seal_request(file_id: str, user_id: str, channel_id: str, message_ts: str, client):
    """인감날인 요청"""
    try:
        user_name = get_user_real_name(client, user_id)
        await update_document_status(file_id, "인감날인 요청", user_name)
        
        client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=f"✅ *처리 완료*\n\n<@{user_id}>님이 인감날인을 요청했습니다.",
            blocks=[]
        )
    except Exception as e:
        print(f"❌ 오류: {e}")

async def handle_recheck(file_id: str, user_id: str, channel_id: str, message_ts: str, client):
    """재검토 요청"""
    try:
        user_name = get_user_real_name(client, user_id)
        await update_document_status(file_id, "재검토 중", user_name)
        
        client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text=f"✅ *재검토 요청 완료*\n\n재무팀에서 재검토를 진행 중입니다.",
            blocks=[]
        )
    except Exception as e:
        print(f"❌ 오류: {e}")

async def handle_cancel(channel_id: str, message_ts: str, client):
    """취소"""
    try:
        client.chat_update(
            channel=channel_id,
            ts=message_ts,
            text="❌ 처리가 취소되었습니다.",
            blocks=[]
        )
    except Exception as e:
        print(f"❌ 오류: {e}")

# ==================== 이벤트 핸들러 ====================

@app_fastapi.post("/api/slack/events")
async def slack_events(request: Request):
    """Slack 이벤트"""
    try:
        body = await request.json()
        
        if body.get("type") == "url_verification":
            return {"challenge": body["challenge"]}
        
        if body.get("type") == "event_callback":
            event = body.get("event", {})
            
            if event.get("type") == "file_shared":
                file_id = event.get("file_id")
                channel_id = event.get("channel_id")
                user_id = event.get("user_id")
                
                print(f"✅ 파일 업로드: {file_id}")
                
                if file_id and channel_id:
                    try:
                        await auto_detect_and_process_files(
                            file_id=file_id,
                            channel_id=channel_id,
                            user_id=user_id,
                            client=slack_app.client
                        )
                    except Exception as e:
                        print(f"❌ 처리 오류: {e}")
        
        return JSONResponse({"ok": True})
    
    except Exception as e:
        print(f"❌ 이벤트 오류: {e}")
        return JSONResponse({"ok": False}, status_code=500)

# ==================== 인터랙션 핸들러 ====================

@app_fastapi.post("/api/slack/interactions")
async def slack_interactions(request: Request):
    """Slack 인터랙션"""
    try:
        form_data = await request.form()
        payload_str = form_data.get("payload")
        
        if not payload_str:
            return JSONResponse({"ok": False}, status_code=400)
        
        payload = json.loads(payload_str)
        
        if payload.get("type") == "block_actions":
            actions = payload.get("actions", [])
            if not actions:
                return JSONResponse({"ok": False}, status_code=400)
            
            action = actions[0]
            action_id = action.get("action_id")
            value = action.get("value", "")
            user_id = payload.get("user", {}).get("id")
            container = payload.get("container", {})
            channel_id = container.get("channel_id")
            message_ts = container.get("message_ts")
            
            print(f"🎯 액션: {action_id}")
            
            parts = value.split("|")
            if len(parts) < 2:
                return JSONResponse({"ok": False}, status_code=400)
            
            file_id = parts[0]
            action_type = parts[1]
            risk_level = parts[2] if len(parts) > 2 else "MEDIUM"
            
            if action_type == "request_seal":
                await handle_seal_request(file_id, user_id, channel_id, message_ts, slack_app.client)
            elif action_type == "recheck":
                await handle_recheck(file_id, user_id, channel_id, message_ts, slack_app.client)
            elif action_type == "cancel":
                await handle_cancel(channel_id, message_ts, slack_app.client)
            
            return JSONResponse({"ok": True})
        
        return JSONResponse({"ok": True})
        
    except Exception as e:
        print(f"❌ 인터랙션 오류: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

# ==================== 헬스 체크 ====================

@app_fastapi.get("/health")
async def health_check():
    return {"status": "ok"}

@app_fastapi.get("/")
async def root():
    return {"status": "Slack Legal Review Bot is running"}

@app_fastapi.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return {"status": "ok"}

app = app_fastapi
