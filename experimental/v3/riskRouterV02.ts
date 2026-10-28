// V3 실험 — 결정론적 모호성 위험 라우터 v0.2 (LLM 미사용, 추가 API 비용 0).
//
// v0.1(riskRouter.ts)은 재현성을 위해 그대로 두고, 이 파일에서 v0.1 의 알려진 한계를 고친다.
// 경로·등급 의미는 v0.1 과 같다: HIGH → B(정밀 분석), UNCERTAIN → C(기본: 정밀 분석), LOW → A(분석 생략).
//
// v0.1 대비 변경 (모두 v0.1 테스트의 it.fails·설계 문서 '알려진 한계'와 개발 사례 분석에서 나온 일반 규칙):
//   1. 산출물 추출: "~을 작성했습니다" 외에 실제 본문 형식([머리말], "시안 1:", 표·긴 본문)도 산출물로 본다.
//      가운뎃점·범위 병렬 표기(1차·2차 설문지, [오전·오후 진행표], 1~3부 원고)를 여러 산출물로 나눈다.
//      "찬성 측과 반대 측 입론"처럼 뒤 명사를 공유하는 병렬은 앞 항목에도 머리 명사를 붙인다.
//   2. 대상 명사 매칭: 토큰 단위로 비교하고, 2글자 미만으로 줄어드는 조사 제거를 하지 않는다('화가'→'화' 방지).
//      과거 지시어(아까·전에)가 명사와 함께 오면: 일치 산출물 1개 → 해소, 2개 이상 → REF_PAST_MULTI (G1a 개선).
//   3. 동명이인·같은 이름 대상: 문맥이 "'X'가 두 명/세 개"처럼 같은 이름의 복수를 밝히면, 요청이 그 이름을
//      명시해도 확정으로 보지 않는다(REF_HOMONYM). 요청에 구분 속성(학년·팀·폴더 등)이 있으면 해소.
//   4. 인용된 "새 값"('…'으로 바꿔줘)은 대상 명시가 아니다. 바꿀 자리(조항·칸·마감일)가 문맥에 여럿이면 HIGH.
//   5. 문서 안 같은 대상이 여러 줄에 나오면(지급 조항 2곳, 일시 2곳, 같은 이름 2줄) DOC_SPAN_MULTI.
//   6. 작업 범위(scope): 외부 자원(파일·메시지·예약·구독·권한 등) vs 대화 산출물·문서 내부 편집을 구분한다.
//      비가역 신호(IRREV_*)와 가드 G2 는 외부 자원 작업에만 적용한다(내부 편집을 비가역으로 보던 v0.1 과잉 탐지 수정).
//   7. 관점 모호성(PERSPECTIVE_MULTI), 문맥 인용 속 대명사로만 지칭된 인물(HIDDEN_REFERENT),
//      위치·일정·개인 일화·지난 회의 결정 같은 상황 정보 누락(INFO_*)을 추가로 탐지한다.
//   8. 비교 기준은 사용자 발화의 주제어(…은/는) 개수로 센다. '지난번처럼'의 '지난번'은 과거 지시어로 보지 않는다.
//   9. 서수가 산출물 안 위치(두 번째 문장·마지막 항목)를 가리키면 산출물 선택으로 보지 않는다.
//
// v0.2.1 (2026-10-15, 스트레스셋·Final 셋 결과를 본 뒤 수정 — 변경 이력은 experimental/v3/pilot/router-history.jsonl):
//   v0.2.0 이 내부 편집을 비가역에서 빼면서 v0.1 의 안전망(IRREV_WEAK → 분석)까지 없앤 회귀를 고친다.
//   - EDIT_TARGET_WEAK: 대상이 서술로만 주어진 삭제·교체는 내부 편집이어도 분석(경로 C). G2 는 여전히 외부만.
//   - 문서 다중 대상은 문장 단위로, 문서 일부 편집 요청에만 본다. 미결정 신호는 편집 동작에도 적용.
//   - 교체·대체를 파괴적 편집으로, 저장소 문맥의 문서 교체를 외부 작업으로, 괄호 든 파일명, 개수 표지(세 문단 등),
//     본인 경험·소속 조직 사실·"갈 만한 장소" 정보 누락을 추가.
//   고정된 v0.2.0 은 riskRouterV02_0.ts (SHA 2a16ab3f) 에 그대로 보존한다.
//
// 한계: 여전히 표면 표현 규칙이다. 규칙이 못 잡는 의미적 모호성은 경량 모델 라우터(lightRouter.ts)가 맡는다.

import type { Route, RiskTier, SignalId, ResolutionId } from "./riskRouter.js";
export type { Route, RiskTier };

export type ActionScope = "external" | "internal_edit" | "none";

export type SignalIdV02 =
  | SignalId
  | "REF_HOMONYM" // 같은 이름의 대상이 여럿이라고 문맥이 밝힘 (HIGH)
  | "DOC_SPAN_MULTI" // 요청 대상 표현이 문서의 여러 줄에 나옴 (HIGH)
  | "PERSPECTIVE_MULTI" // '…쪽/그분 입장에서' + 문맥에 당사자 2명 이상 (HIGH)
  | "HIDDEN_REFERENT" // 문맥 인용 속 '그 직원' 같은 대명사로만 지칭된 인물을 요청이 서술로 가리킴 (HIGH)
  | "INFO_LOCATION" // 근처·동네 장소 정보가 핵심인데 위치 없음
  | "INFO_SCHEDULE" // '이번 출장 일정에 맞춰' 등 일정 정보가 핵심인데 없음
  | "INFO_ANECDOTE" // 개인 일화·경험을 넣어 달라는데 내용 없음
  | "INFO_PAST_DECISION" // '지난주 회의에서 정한 …' 내용이 문맥에 없음
  | "EDIT_TARGET_WEAK"; // v0.2.1: 대상이 서술로만 주어진 삭제·교체(내부 편집 포함) — 근거 약함 (UNCERTAIN)

export type ResolutionIdV02 =
  | ResolutionId
  | "REF_DISAMBIGUATED" // 복수 후보 중 요청의 구분 속성으로 하나
  | "REF_INTRA_POSITION" // 산출물 하나 안의 위치(두 번째 문장 등)
  | "REF_INLINE_PAYLOAD" // 요청에 작업할 본문이 직접 들어 있음
  | "VALUE_QUOTED" // 인용문은 대상이 아니라 새 값
  | "REF_DOC_SPAN_UNIQUE"; // v0.2.1: 요청이 서술한 대상이 문서의 한 곳에만 나옴

export interface RiskSignalV02 {
  id: SignalIdV02;
  tier: RiskTier;
  detail: string;
  candidates?: string[];
}
export interface ResolutionV02 {
  id: ResolutionIdV02;
  detail: string;
}
export interface ArtifactV02 {
  name: string;
  noun: string;
  turn: number;
  group: number;
  afterSwitch: boolean;
  source: "phrase" | "header" | "label" | "request";
}
export interface RiskAssessmentV02 {
  router_version: string;
  tier: RiskTier;
  route: Route;
  scope: ActionScope;
  irreversible: boolean;
  signals: RiskSignalV02[];
  resolutions: ResolutionV02[];
  artifacts: ArtifactV02[];
  deixis: string[];
}
export interface RouterInput {
  current_user_request: string;
  recent_conversation?: string[];
  document_context?: string;
}
export interface RouterOptionsV02 {
  /** 대상 근거가 강한 외부 비가역 작업을 어디로 보낼지. 기본 A. */
  irreversibleResolvedRoute?: "A_DIRECT" | "C_UNCERTAIN";
}

export const ROUTER_V02_VERSION = "v3-router-0.2.1";

// ---------------- 어휘 ----------------

const TIER_RANK: Record<RiskTier, number> = { LOW: 0, UNCERTAIN: 1, HIGH: 2 };

const BARE_DEMONSTRATIVE = /(?:^|[\s"'(])(그거|그것|이거|이것|저거|저것|그걸|이걸|그게|이게|그건|이건|그때|거기|그쪽|그곳)(?=[\s,.!?을를이가은는도만에로]|$)/;
const RELATIVE_THING = /(쓴|만든|작성한|정리한|짠|보낸|준)\s*(거|것)(?=[\s,.!?을를이가은는도만에]|$)/;
const DETERMINER_NOUN = /(?:^|\s)(그|이|저|해당)\s+([가-힣A-Za-z0-9_]+)/g;
const SURNAME_TITLE = /^(과장님|대리님|교수님|선생님|팀장님|부장님|사원|주임|선배|후배|님|씨)/;
const PERSON_DEIXIS = /(그분|이분|저분|그\s*사람|그\s*친구|그\s*선배|그\s*후배|그\s*교수님|그\s*선생님)/;
const PAST_DEIXIS = /(아까|이전에|예전에|앞에서|앞서|위에서|위의|저번에|지난번에|(?<![가-힣])전에)/;
const RECENCY_MARKER = /(방금|가장\s*최근|마지막으로|바로\s*전|지금\s*막|최근에\s*만든)/;
const TEXT_UNIT = "(문장|문단|단락|줄|항목|행|열|칸|장|절|쪽|페이지|슬라이드|문항|조항|단어|부분)";
const INTRA_POSITION = new RegExp(`(첫|두|세|네|다섯|마지막|맨\\s*끝|끝|\\d+)\\s*(번째)?\\s*${TEXT_UNIT}`);
const ORDINAL = /(첫\s*번째|두\s*번째|세\s*번째|네\s*번째|처음에\s*(쓴|만든|작성한|정한)|마지막에\s*(쓴|만든|작성한)|(\d+)\s*번째)/;
const ORDINAL_VALUE: Array<[RegExp, number | "last"]> = [
  [/첫\s*번째|처음에/, 1],
  [/두\s*번째/, 2],
  [/세\s*번째/, 3],
  [/네\s*번째/, 4],
  [/마지막에/, "last"],
];
const FILENAME = /([\w가-힣\-()]+\.(xlsx|xls|docx|doc|pptx|ppt|pdf|hwp|txt|csv|png|jpg|zip|md))/i;
const EXPLICIT_ID = /((\d+)\s*번\s*(항목|슬라이드|문단|조|줄|행|안))|(제?\d+조)|(\d+안)|([A-Z]안)|(\d+\s*(차|부|기|분기|반))\s/i;
const QUOTED = /'([^']+)'|"([^"]+)"|‘([^’]+)’|“([^”]+)”|「([^」]+)」/g;
const NAMED_PERSON = /([가-힣]{2,4})\s*(님|씨)/g;
const INLINE_PAYLOAD = /[:：]\s*\S[\s\S]{4,}$/;

// 작업 범위
const INFORMATIONAL = /(방법|어떻게|설명해|알려\s?줘|뭐야|차이|의미|절차|주의할\s*점|예시\s*보여)/;
const DRAFT_ONLY = /((?<!덮어)써\s?줘|작성해\s?줘|만들어\s?줘|짜\s?줘)/;
const EXTERNAL_ACTION =
  /(보내\s?줘|보내\s?주|발송해|전송해|게시해|올려\s?줘|공유해|해지해|탈퇴해|취소해|취소\s?처리|취소\s?진행|환불해|환불\s*신청|주문해|결제해|예약해\s?줘|신청해\s?줘|철회|해제해|업로드해|영구\s*삭제|답장\s*보내)/;
const REMOVE_VERB = /(교체|대체|삭제|지워|지우|제거|없애|폐기|빼\s?줘|빼\s?주|덮어)/;
const EXTERNAL_OBJ =
  /(파일|폴더|드라이브|첨부|메일|이메일|문자|메시지|단톡방|카톡|캘린더|일정|예약|구독|계정|권한|주문|결제|티켓|수강|참가|공유\s*링크|링크|게시판|채널|연락처|장바구니|제출\s*목록|미팅)/;
const EDIT_VERB = /(바꿔|고쳐|수정|추가|줄여|늘려|다듬어|넣어|교체|대체|옮겨|번역|정리해|요약해|풀어|맞춰)/;

// 문맥 상태
const MULTI =
  /((두|세|네|여러)\s*(개|가지|군데|분|명|건|장|종류|곳|편|번|통|줄|칸|부|버전|벌|팀|반|권|문단|문장|절|항목|슬라이드|조항|파일|시안)|둘\s*(다|중|모두)|하나는.*하나는|중\s*하나|각각|따로\s*있|하나씩|(이랑|랑|하고|와|과)\s+.{1,15}?\s*중(에|에서)?(?=[\s,]|$)|\d+\s*(조|장|절|항|번|쪽|페이지)\s*(랑|이랑|와|과|하고|,)\s*\d+\s*(조|장|절|항|번|쪽|페이지))/;
const COUNT_MULTI = /(두|세|네|여러)\s*(개|명|분|건|장|곳|군데|통|권|벌)|같은\s*이름/;
const QUOTED_PAIR = /['"‘“][^'"’”]+['"’”]\s*(와|과|랑|이랑|하고|,)\s*['"‘“][^'"’”]+['"’”]/;
const PERSON_PAIR = /([가-힣]{1,4}\s?[가-힣]{0,3}님)\s*(이랑|랑|과|와|하고)\s*([가-힣]{1,4}\s?[가-힣]{0,3}님)|((팀장님|선배|후배|교수님|조교님|과장님|대리님)\S*\s*(과|와|이랑|랑|하고)\s*\S+)/;
const SELECTION =
  /((으로|로)\s*(가기로\s*)?(정했|확정)|확정본|최종\s*확정|필요\s*없(어|어졌|음)|아무도\s*안\s*써|만\s*(아직\s*)?남(았|아)|이미\s*보냈|삭제\s*대상으로|하나만\s*(아직|남)|이제\s*안\s*(봐|써|가|해|들어)|취소됐|못\s*가|안\s*가게|이미\s*끝났)/;
const UNDECIDED =
  /((아직|미처)\s*(안|못)\s*(정했|정해|확인|결정)|(아직|미처)\s*\S*\s*(정하지|확인하지|결정하지|확인\s*못|확인\s*안|못\s*정|안\s*정)|(결정|확정|선택)\s*(을\s*)?(못|안)\s*(했|해)|고민\s*(중|이야|이에요|돼|됨)|정하지\s*못|모르겠|어느\s*(쪽|것|걸|게)인지|어디를\s*\S*\s*할지|확정\s*(안|못)|중\s*하나로\s*할\s*것\s*같|(할|갈|쓸|볼|살|낼|둘|남길)지\s+.{1,20}?(할|갈|쓸|볼|살|낼|둘|남길)지)/;
const TOPIC_SWITCH = /이제\s+.+?(쓰자|하자|만들자|넘어가자|해보자|작성하자|짜자)/;
const PRODUCTION = /^(.+?)(을|를)\s*(작성|만들|제안|정리|구성|짜|작성해|만들어)\S*\s*(했|드렸|었)/;
const MODIFICATION = /(추가|수정|변경|반영|삭제)했습니다/;
const HEADER = /^\s*\[([^\]\n]{1,40})\]/gm;
const LABEL = /^\s*((?:시안|안|버전|초안)\s*\d+|\d+\s*안|[A-Z]\s*안)\s*[:：]/;
const USER_PRODUCE = /(써\s?줘|써\s?주세요|만들어\s?줘|작성해\s?줘|짜\s?줘|정리해\s?줘|뽑아\s?줘|추천해\s?줘|제안해\s?줘|줘|하나\s*더)\.?\s*$/;
const CONFIRMATION = /(확인했습니다|알겠습니다|저장했습니다|확정했습니다|정리했습니다\.?$|군요|네요|입니다\.?$)/;

// 정보 누락
const INFO_NOUNS =
  "(졸업\\s*작품|주제|성적|성적표|전공|경력|이력|실적|매출|지출|내역|경험|포트폴리오|주소|위치|근처|동네|점수|연봉|수상|자격증|업무|일정|시간표|날짜|자기소개서|성장\\s*과정|몸무게|체중|키(?=[와과랑,\\s])|예산|제도|복지|규정|정책|관심\\s*분야)";
const INFO_PERSONAL = new RegExp(`(^|\\s)(내|나의|제|저의|우리\\s*[가-힣]{0,6})\\s*([가-힣\\s]{0,16}?)${INFO_NOUNS}`);
const INFO_ACTUAL = /실제(로)?\s*(\S+\s*){0,3}?(수치|매출|지출|비용|내역|금액|데이터|기록|성적|결과|KPI|성과|지표|실적)/;
const INFO_SELF_REF = /(내가|제가|저번에|지난번에)\s*(\S+\s*)?(말한|얘기한|알려준|정한|적은|보낸|말했던)/;
const INFO_LOC = /((근처|주변|가까운|동네)\S*\s*.{0,20}?(장소|빵집|소아과|병원|식당|카페|체험|가게|맛집|약국|학원|공원|코스))|((갈|가볼|놀러\s*갈|다녀올)\s*만한\s*.{0,10}?(장소|곳|코스))/;
// v0.2.1: 본인 경험("제가 들은 수업") · 소속 조직 고유 사실("우리 팀 성과")
const INFO_EXPERIENCE = /(내가|제가|저희가|우리가)\s*.{0,20}?(들은|받은|다녀온|겪은|했던|참여한|읽은|만난)/;
const INFO_ORG = /우리\s*(팀|회사|가게|제품|학교|동아리|부서|브랜드|서비스)\S*\s*.{0,12}?(성과|실적|현황|역사|변화|바뀌어|변천|매출|문화)/;
const INFO_SCHED = /(이번|다음|내)\s*(달\s*)?\S*\s*(출장|여행|시간표|일정|스케줄)\S*\s*(에\s*)?(맞춰|맞게|따라|기준)/;
const INFO_ANEC = /(이야기|사연|추억|에피소드|일화|경험)\S*\s*(을|를)?\s*(꼭|반드시|좀|많이)?\s*(넣어|담아|살려|바탕으로|녹여)/;
const INFO_PASTDEC = /(지난주|어제|지난|저번|아까)\s*\S*\s*(회의|모임|미팅|통화)\S*\s*(에서|때)?\s*(정한|결정한|논의한|나온|합의한)/;
const OPEN_EXAMPLE = /(예시|샘플|아이디어|템플릿|양식|후보|추천|이름\s*지어|브레인스토밍)/;
const STRICT_DEGREE = /((딱|정확히|꼭|반드시|엄격히)\s*\S*\s*(맞춰|맞게|지켜))|((분량|글자\s*수|자수|길이|시간|규정|제한)\S*\s*(에\s*)?(딱|정확히|꼭)?\s*(맞춰|맞게|지켜))/;
const VALUE_WITH_UNIT = /\d+\s*(자|분|쪽|페이지|단어|줄|장|초|매|시간)|(한|두|세|네|다섯|반)\s*(장|쪽|페이지|줄|문단|문장)/;

// 관점·인물
const PERSPECTIVE = /([가-힣]+(?:\s+[가-힣]+){0,3})\s*(입장|관점|시각)(에서|으로)/;
const PARTY_PAIR = /([가-힣]{2,6}?)(님)?\s*(와|과|랑|이랑|하고)\s+([가-힣]{2,6}?)(님)?(이|가|은|는|에게|한테)(?=\s)/g;
const SUBJ_OBJ_PAIR = /([가-힣]{2,4})(이|가)\s+([가-힣]{2,4}?)(이)?(한테|에게|께)/g;
const PARTY_MARK = /(두\s*(팀|분|명|사람|당사자)|둘\s*중|한쪽|양쪽|한\s*명이|한\s*팀은)/;
const QUOTED_DEICTIC_ROLE = /['"‘“][^'"’”]*?그\s*(직원|사람|매니저|학생|친구|분|선배|후배|팀원|담당자|고객)/;
const ROLE_NOUN = /(직원|사람|매니저|학생|친구|분|선배|후배|팀원|담당자|고객)/;

// 비교
const COMPARISON =
  /(전처럼|예전처럼|지난번처럼|아까처럼|저번처럼|이전처럼|작년처럼|(예전|이전|지난번?|저번)\s*(스타일|방식|형식|톤|느낌)(으로|대로)|(?<![가-힣])전(과|이랑|하고|랑)\s*(비슷|같은|똑같|동일)|(예전|이전|지난번?|저번)(과|이랑|하고|랑)\s*(비슷|같은|똑같|동일)|같은\s*(톤|스타일|느낌|형식|방식)|비슷한\s*(톤|스타일|느낌|형식))/;
const COMPARISON_G = new RegExp(COMPARISON.source, "g");
const TOPIC = /([가-힣A-Za-z0-9]+)(은|는)(?=[\s,])|(?:^|\s)(건|거는|것은)(?=\s)/g;
const TOPIC_STOP = new Set(["나", "저", "난", "전", "이건", "그건", "저건", "오늘", "이번", "요즘", "지금", "그거", "이거", "우리", "저희", "참고로"]);

const PARTICLES = /(은|는|이|가|을|를|에|에서|에게|께|로|으로|와|과|랑|이랑|도|만|의|야|이야|요)$/;
const STOP = new Set(["지금", "해줘", "줘", "좀", "더", "이번", "오늘", "내일", "다시", "모두", "전체", "그", "이", "저", "거", "것", "하나", "두", "둘", "있어", "했어", "다음", "있는데", "확인했습니다"]);
const GENERIC_NOUN = new Set(["문서", "내용", "부분", "수정본", "초안", "최종본", "버전", "자료", "전체", "작성했습니다", "만들었습니다", "정리했습니다"]);
const NOUN_ENDING_EXCEPTIONS = ["결과", "효과", "성과", "교과", "학과", "부과"];

// ---------------- 유틸 ----------------

function stripParticle(t: string): string {
  const s = t.replace(PARTICLES, "");
  return s.length >= 2 ? s : t; // '화가'→'화' 같은 과잉 제거 방지
}

export function tokensV02(text: string): string[] {
  return text
    .replace(/[^가-힣A-Za-z0-9_\s]/g, " ")
    .split(/\s+/)
    .map(stripParticle)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

const tokMatch = (a: string, b: string) => a === b || (a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 2);

function parseTurns(conv: string[]) {
  return conv.map((raw, i) => {
    const m = raw.match(/^\s*(User|Assistant|사용자|어시스턴트)\s*[:：]\s*([\s\S]*)$/i);
    const role = m ? (/^(user|사용자)$/i.test(m[1]) ? "user" : "assistant") : "unknown";
    return { i, role, text: (m ? m[2] : raw).trim() };
  });
}

function expandParallel(phrase: string): string[] {
  // 1~3부 사회 원고 → 1부/2부/3부
  const range = phrase.match(/^(.*?)(\d+)\s*~\s*(\d+)\s*(부|차|주|회|장|편|기)(.*)$/);
  if (range) {
    const [, pre, a, b, unit, rest] = range;
    const out: string[] = [];
    for (let k = Number(a); k <= Number(b) && out.length < 6; k++) out.push(`${pre}${k}${unit}${rest}`.trim());
    if (out.length >= 2) return out;
  }
  // 1차·2차 설문지, 상·하반기 요약, [오전·오후 진행표]
  const words = phrase.split(/\s+/);
  const wi = words.findIndex((w) => /·|ㆍ|・/.test(w));
  if (wi >= 0) {
    const parts = words[wi].split(/·|ㆍ|・/).filter(Boolean);
    const last = parts[parts.length - 1];
    const rest = words.slice(wi + 1).join(" ");
    const pre = words.slice(0, wi).join(" ");
    return parts.map((p) => {
      const full = p.length === 1 && last.length > 1 ? p + last.slice(1) : p;
      return [pre, full, rest].filter(Boolean).join(" ");
    });
  }
  return [phrase];
}

function splitConjunction(phrase: string): string[] {
  const parts: string[] = [];
  let rest = phrase;
  for (;;) {
    const m = rest.match(/^(.+?)(과|와|이랑|랑)\s+(.+)$/);
    if (!m) break;
    const left = m[1];
    if (NOUN_ENDING_EXCEPTIONS.some((e) => (left + m[2]).endsWith(e))) break;
    parts.push(left.trim());
    rest = m[3];
  }
  parts.push(rest.trim());
  const clean = parts.filter(Boolean);
  // 머리 명사 공유: "찬성 측과 반대 측 입론" → "찬성 측 입론"
  if (clean.length >= 2) {
    const lastWords = clean[clean.length - 1].split(/\s+/);
    const head = lastWords[lastWords.length - 1];
    if (lastWords.length >= 2) {
      for (let i = 0; i < clean.length - 1; i++) {
        const w = clean[i].split(/\s+/);
        if (!clean[i].includes(head) && w.length < lastWords.length) clean[i] = `${clean[i]} ${head}`;
      }
    }
  }
  return clean.flatMap(expandParallel);
}

function requestObject(userText: string): string {
  return userText
    .replace(/^(이번엔|이번에는|그리고|그럼|이제|다음으로)\s*/, "")
    .replace(/(을|를|도)?\s*(같이\s*)?(써\s?줘|써\s?주세요|만들어\s?줘|작성해\s?줘|짜\s?줘|정리해\s?줘|뽑아\s?줘|추천해\s?줘|제안해\s?줘|줘)\.?\s*$/, "")
    .replace(/[.?!]+$/, "")
    .trim();
}

export function extractArtifactsV02(conv: string[]): ArtifactV02[] {
  const turns = parseTurns(conv);
  const switchIdx = Math.max(-1, ...turns.filter((t) => t.role === "user" && TOPIC_SWITCH.test(t.text)).map((t) => t.i));
  const out: ArtifactV02[] = [];
  let group = 0;
  const push = (names: string[], t: { i: number }, source: ArtifactV02["source"]) => {
    group++;
    for (const n of names) out.push({ name: n, noun: n, turn: t.i, group, afterSwitch: switchIdx >= 0 && t.i > switchIdx, source });
  };
  for (const t of turns) {
    if (t.role !== "assistant" || MODIFICATION.test(t.text)) continue;
    const m = t.text.match(PRODUCTION);
    if (m) {
      const phrase = m[1].replace(/^(제가|네,?|알겠습니다\.?)\s*/, "").trim();
      const plural = phrase.match(/^(두|세|네)\s+(?!번째)(.+)$/);
      if (plural) {
        const n = { 두: 2, 세: 3, 네: 4 }[plural[1] as "두" | "세" | "네"];
        push(Array.from({ length: n }, (_, k) => `${plural[2]}#${k + 1}`), t, "phrase");
      } else push(splitConjunction(phrase), t, "phrase");
      continue;
    }
    const headers = [...t.text.matchAll(HEADER)].map((h) => h[1].trim());
    if (headers.length) {
      push(headers.flatMap(expandParallel), t, "header");
      continue;
    }
    const label = t.text.match(LABEL);
    if (label) {
      push([label[1].replace(/\s+/g, " ")], t, "label");
      continue;
    }
    const prev = turns.slice(0, t.i).reverse().find((x) => x.role === "user");
    const looksArtifact = t.text.includes("\n") || t.text.length >= 40 || /^[#|]/.test(t.text);
    if (prev && USER_PRODUCE.test(prev.text) && looksArtifact && !CONFIRMATION.test(t.text.split("\n")[0])) {
      push(splitConjunction(requestObject(prev.text) || "산출물"), t, "request");
    }
  }
  if (switchIdx >= 0 && out.some((a) => a.afterSwitch)) return out.filter((a) => a.afterSwitch);
  return out;
}

function nounMatchesV02(artifacts: ArtifactV02[], requestText: string): ArtifactV02[] {
  const reqFlat = requestText.replace(/\s+/g, "");
  const reqTok = tokensV02(requestText).filter((t) => !GENERIC_NOUN.has(t));
  return artifacts.filter((a) => {
    const n = a.noun.replace(/#\d+$/, "").replace(/\s+/g, "");
    if (n.length >= 2 && reqFlat.includes(n)) return true;
    const aTok = tokensV02(a.noun.replace(/#\d+$/, "")).filter((t) => !GENERIC_NOUN.has(t) && !/^\d/.test(t));
    return aTok.some((x) => reqTok.some((y) => tokMatch(x, y)));
  });
}

function latestGroup<T extends { group: number }>(artifacts: T[]): T[] {
  if (!artifacts.length) return [];
  const g = Math.max(...artifacts.map((a) => a.group));
  return artifacts.filter((a) => a.group === g);
}

function ordinalIndex(text: string): number | "last" | null {
  for (const [re, v] of ORDINAL_VALUE) if (re.test(text)) return v;
  const m = text.match(/(\d+)\s*번째/);
  return m ? Number(m[1]) : null;
}

function quotedStrings(s: string): string[] {
  return [...new Set([...s.matchAll(QUOTED)].map((m) => m.slice(1).find(Boolean)!).filter(Boolean))];
}

/** 인용문이 "새 값"인지(…'V'로 바꿔줘 / …'V'라고) 판정. 새 값이면 대상 명시가 아니다. */
function isNewValueQuote(request: string, q: string): boolean {
  const i = request.indexOf(q);
  if (i < 0) return false;
  const after = request.slice(i + q.length + 1, i + q.length + 30);
  return /^\s*(으로|로|라고|이라고)\s*(\S+\s*)?(바꿔|고쳐|수정|변경|교체|대체|해\s?줘|맞춰|적어|넣어|써)/.test(after) || /^\s*(으로|로)\s*$/.test(after.slice(0, 4));
}

// ---------------- 평가 ----------------

export function assessRiskV02(input: RouterInput, opts: RouterOptionsV02 = {}): RiskAssessmentV02 {
  const request = input.current_user_request.trim();
  const conv = (input.recent_conversation ?? []).filter((t) => t.trim());
  const doc = (input.document_context ?? "").trim();
  const ctxText = [...conv, doc].join("\n");
  const ctxEmpty = !conv.length && !doc;
  const turns = parseTurns(conv);
  const userCtx = turns.filter((t) => t.role === "user").map((t) => t.text);
  const inlinePayload = INLINE_PAYLOAD.test(request);
  const payloadStripped = request.replace(/(문장|문구|글|다음|아래|이것|이거)[^:：]*[:：][\s\S]*$/, (m) => m.split(/[:：]/)[0]);
  const command = payloadStripped.replace(QUOTED, " ");
  const commandNoCmp = command.replace(COMPARISON_G, " ");
  const artifacts = extractArtifactsV02(conv);
  const signals: RiskSignalV02[] = [];
  const resolutions: ResolutionV02[] = [];
  const deixis: string[] = [];
  const add = (id: SignalIdV02, tier: RiskTier, detail: string, candidates?: string[]) => signals.push({ id, tier, detail, candidates });
  const resolve = (id: ResolutionIdV02, detail: string) => resolutions.push({ id, detail });
  const hasSignal = (id: SignalIdV02) => signals.some((s) => s.id === id);

  const ctxSentences = ctxText.split(/\n+|[.!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean);
  const multiSentences = ctxSentences.filter((s) => MULTI.test(s) || QUOTED_PAIR.test(s) || PERSON_PAIR.test(s));
  const selection = SELECTION.test(ctxText);
  const undecided = UNDECIDED.test(ctxText);
  const reqTokens = tokensV02(command);

  // ---- 작업 범위 ----
  const informational = INFORMATIONAL.test(command) && !EXTERNAL_ACTION.test(command);
  let scope: ActionScope = "none";
  if (!informational) {
    if (EXTERNAL_ACTION.test(command)) scope = "external";
    else if (REMOVE_VERB.test(command) && (EXTERNAL_OBJ.test(command) || FILENAME.test(request))) scope = "external";
    else if (REMOVE_VERB.test(command) || (EDIT_VERB.test(command) && (artifacts.length > 0 || !!doc || inlinePayload))) scope = "internal_edit";
  }
  if (scope === "external" && DRAFT_ONLY.test(command) && !EXTERNAL_ACTION.test(command)) scope = "none";
  // v0.2.1: 저장소(폴더·드라이브·파일명)가 문맥에 있고 문서·파일을 지우거나 교체하면 외부 자원 작업
  if (scope !== "external" && !informational && REMOVE_VERB.test(command) && /(문서|파일|원본|초안|버전|최종본|백업)/.test(command) && !artifacts.length && (FILENAME.test(ctxText) || /(폴더|드라이브|클라우드|서버)/.test(ctxText))) scope = "external";

  // ---- 명시적 대상 + 같은 이름 복수(동명이인) ----
  const reqQuotes = quotedStrings(request);
  const valueQuotes = reqQuotes.filter((q) => isNewValueQuote(request, q));
  const targetQuotes = reqQuotes.filter((q) => !valueQuotes.includes(q));
  if (valueQuotes.length) resolve("VALUE_QUOTED", `인용 '${valueQuotes.join("', '")}'은 새 값`);
  const explicitKeys: string[] = [];
  const fn = request.match(FILENAME)?.[1];
  if (fn) explicitKeys.push(fn);
  for (const q of targetQuotes) explicitKeys.push(q);
  for (const m of command.matchAll(NAMED_PERSON)) {
    const name = m[1];
    if (ctxText.split(name).length - 1 >= 1) explicitKeys.push(name);
  }
  const idMatch = command.match(EXPLICIT_ID);
  let explicit = explicitKeys.length > 0 || !!idMatch;

  // 문맥이 "같은 이름의 복수"를 밝혔는지: 셈 표지 + 서로 다른 인용 대상이 1개 이하
  const homonymFor = (key: string): { sentence: string; turnText: string } | null => {
    const k = key.replace(/\s+/g, "");
    for (const t of turns) {
      const sents = t.text.split(/\n+|[.!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean);
      for (const s of sents) {
        if (!COUNT_MULTI.test(s) || quotedStrings(s).length >= 2) continue;
        const sFlat = s.replace(/\s+/g, "");
        if (sFlat.includes(k) || (k.length >= 2 && quotedStrings(s).some((q) => q.replace(/\s+/g, "") === k))) return { sentence: s, turnText: t.text };
      }
    }
    return null;
  };
  const disambiguatedBy = (sentence: string, turnText: string): string | null => {
    const sTok = new Set(tokensV02(sentence));
    const others = turnText
      .split(/\n+|[.!?](?=\s|$)/)
      .map((s) => s.trim())
      .filter((s) => s && s !== sentence);
    const desc = new Set(others.flatMap((s) => tokensV02(s)).filter((t) => !sTok.has(t)));
    // 같은 문장 안 "하나는 X, 하나는 Y" 형태도 구분 속성으로 본다
    for (const m of sentence.matchAll(/(하나는|한\s*명은|한\s*분은)\s*([가-힣A-Za-z0-9]+)/g)) desc.add(stripParticle(m[2]));
    const hit = reqTokens.find((t) => [...desc].some((d) => d.length >= 2 && tokMatch(t, d) && !GENERIC_NOUN.has(d)));
    return hit ?? null;
  };
  for (const key of explicitKeys) {
    const h = homonymFor(key);
    if (!h) continue;
    const by = disambiguatedBy(h.sentence, h.turnText);
    if (by) resolve("REF_DISAMBIGUATED", `같은 이름 '${key}' 복수 중 '${by}'로 구분`);
    else {
      add("REF_HOMONYM", "HIGH", `문맥에 같은 이름 '${key}'의 대상이 여럿: ${h.sentence}`);
      explicit = false;
    }
  }
  if (explicit && !hasSignal("REF_HOMONYM")) resolve("REF_EXPLICIT", "파일명·인용·번호·고유 이름으로 대상 명시");

  // ---- 문서 안 같은 대상이 여러 곳 (v0.2.1: 줄이 아니라 문장 단위, 문서 일부를 고치는 요청에만) ----
  const partEdit =
    new RegExp(TEXT_UNIT).test(command) || valueQuotes.length > 0 || REMOVE_VERB.test(command) || /(이름|명단|조건|일시|날짜|금액|단가)/.test(command);
  if (doc && !idMatch && partEdit) {
    const units = doc
      .split(/\n+|(?<=[.!?])\s+/)
      .map((l) => l.trim())
      .filter((l) => l && !/^\[[^\]]+\]$/.test(l));
    const DOC_GENERIC = /^(문장|문단|단락|항목|부분|내용|단어|표현|조항|문서|자료)$/;
    const keys = [...new Set([...reqTokens, ...explicitKeys.map((k) => k.replace(/\s+/g, ""))])].filter(
      (t) => t.length >= 2 && !GENERIC_NOUN.has(t) && !DOC_GENERIC.test(t) && !/(해줘|줘|바꿔|고쳐|수정|지워|빼|삭제|요약|정리|써)/.test(t)
    );
    let decided = false;
    for (const k of keys) {
      const hitUnits = units.filter((l) => l.replace(/\s+/g, "").includes(k));
      if (hitUnits.length < 2) continue;
      // 요청에 그중 한 곳에만 있는 구분 토큰이 있으면 해소
      const uniq = reqTokens.find((t) => t !== k && hitUnits.filter((l) => l.replace(/\s+/g, "").includes(t)).length === 1);
      if (uniq) resolve("REF_DISAMBIGUATED", `문서의 '${k}' ${hitUnits.length}곳 중 '${uniq}'로 구분`);
      else add("DOC_SPAN_MULTI", "HIGH", `요청 대상 '${k}'이(가) 문서의 ${hitUnits.length}곳에 나옴`, hitUnits.slice(0, 4));
      decided = true;
      break;
    }
    if (!decided && keys.some((k) => units.filter((l) => l.replace(/\s+/g, "").includes(k)).length === 1)) resolve("REF_DOC_SPAN_UNIQUE", "요청이 서술한 대상이 문서의 한 곳에만 나옴");
  }

  // ---- 지시어 ----
  const bare = commandNoCmp.match(BARE_DEMONSTRATIVE)?.[1] ?? commandNoCmp.match(RELATIVE_THING)?.[0];
  const determiners = [...commandNoCmp.matchAll(DETERMINER_NOUN)]
    .filter((m) => !(m[1] === "이" && SURNAME_TITLE.test(m[2])))
    .map((m) => ({ det: m[1], noun: stripParticle(m[2]) }));
  const person = commandNoCmp.match(PERSON_DEIXIS)?.[1];
  const past = commandNoCmp.match(PAST_DEIXIS)?.[1];
  const recency = commandNoCmp.match(RECENCY_MARKER)?.[1];
  const intra = commandNoCmp.match(INTRA_POSITION)?.[0];
  const ordinalRaw = commandNoCmp.match(ORDINAL)?.[0];
  const ordinal = ordinalRaw && !(intra && intra.includes(ordinalRaw.replace(/\s+/g, " ").trim())) ? ordinalRaw : undefined;
  if (bare) deixis.push(bare);
  for (const d of determiners) deixis.push(`${d.det} ${d.noun}`);
  if (person) deixis.push(person);
  if (past) deixis.push(past);
  if (recency) deixis.push(recency);
  if (ordinal) deixis.push(ordinal);
  if (intra && !ordinal) deixis.push(intra);
  const hasDeixis = deixis.length > 0;

  const detNouns = determiners.map((d) => d.noun);
  const nounHits = nounMatchesV02(artifacts, command);
  const linkedTo = (nouns: string[]) =>
    multiSentences.filter((s) => {
      const st = tokensV02(s);
      return nouns.some((n) => n.length >= 2 && st.some((t) => tokMatch(t, n)));
    });

  if (hasDeixis && !explicit && !hasSignal("REF_HOMONYM")) {
    const docDet = determiners.find((d) => /^(문서|자료|파일|글|보고서|표|목록|명단)/.test(d.noun) && d.det !== "그") ?? (doc && /이\s*(문서|자료)/.test(command) ? { det: "이", noun: "문서" } : undefined);
    const payloadDet = inlinePayload && determiners.some((d) => /^(글|문장|문구|내용|문단|텍스트)/.test(d.noun));
    if (payloadDet) {
      resolve("REF_INLINE_PAYLOAD", "요청에 작업할 본문이 직접 들어 있음");
    } else if (person) {
      const persons = multiSentences.some((s) => PERSON_PAIR.test(s) || /(두|세)\s*(분|명)|둘\s*다/.test(s));
      if (persons) add("REF_PERSON_MULTI", "HIGH", `인물 지시 '${person}' + 문맥 인물 2명 이상`);
      else if (ctxEmpty) add("REF_NO_CONTEXT", "HIGH", `인물 지시 '${person}' + 문맥 없음`);
      else add("REF_UNKNOWN", "UNCERTAIN", `인물 지시 '${person}'의 후보를 셀 수 없음`);
    } else if (docDet && doc) {
      resolve("REF_DOCUMENT", "'이 문서' + 첨부 문서");
    } else if (ordinal) {
      const idx = ordinalIndex(ordinal);
      const pool = nounHits.length >= 2 ? nounHits : artifacts;
      if (idx !== null && pool.length >= (idx === "last" ? 1 : idx)) {
        const target = idx === "last" ? pool[pool.length - 1] : pool[idx - 1];
        resolve("REF_ORDINAL", `서수 '${ordinal}' → ${target.name}`);
      } else add("REF_UNKNOWN", "UNCERTAIN", `서수 '${ordinal}'에 맞는 산출물 목록을 찾지 못함`);
    } else if (recency) {
      const latest = latestGroup(nounHits.length ? nounHits : artifacts);
      if (latest.length === 1) resolve("REF_RECENCY_MARKED", `'${recency}' → ${latest[0].name}`);
      else if (latest.length >= 2) add("REF_GROUP_MULTI", "HIGH", `'${recency}' 산출 턴의 산출물 ${latest.length}개`, latest.map((a) => a.name));
      else add("REF_UNKNOWN", "UNCERTAIN", `'${recency}'가 가리킬 산출물을 찾지 못함`);
    } else if (past) {
      // G1a 개선: 과거 지시어 + 대상 명사. 일치 1개 → 해소, 2개 이상 → 다중
      if (nounHits.length === 1) resolve("REF_NOUN_UNIQUE", `과거 지시어 + 명사가 산출물 '${nounHits[0].name}' 하나와 일치`);
      else if (nounHits.length >= 2) {
        const lg = latestGroup(nounHits);
        if (lg.length === nounHits.length && new Set(nounHits.map((a) => a.group)).size === 1 && nounHits.length >= 2)
          add("REF_GROUP_MULTI", "HIGH", `과거 지시어 + 같은 턴 산출물 ${nounHits.length}개가 명사와 일치`, nounHits.map((a) => a.name));
        else add("REF_PAST_MULTI", "HIGH", `과거 지시어 '${past}' + 명사 일치 산출물 ${nounHits.length}개`, nounHits.map((a) => a.name));
      } else if (detNouns.length && linkedTo(detNouns).length && !selection) {
        add("REF_NOUN_MULTI", "HIGH", `'${detNouns.join(", ")}'이(가) 문맥의 복수 대상과 연결됨`);
      } else {
        const latestG = artifacts.length ? Math.max(...artifacts.map((a) => a.group)) : 0;
        const earlier = artifacts.filter((a) => a.group !== latestG);
        const latest = artifacts.filter((a) => a.group === latestG);
        if (earlier.length >= 2) add("REF_PAST_MULTI", "HIGH", `과거 지시어 '${past}' + 이전 산출물 ${earlier.length}개`, earlier.map((a) => a.name));
        else if (earlier.length === 1) add("REF_PAST_SINGLE", "UNCERTAIN", `과거 지시어 '${past}' + 이전 산출물 1개`, earlier.map((a) => a.name));
        else if (latest.length >= 2) add("REF_GROUP_MULTI", "HIGH", `과거 지시어 + 같은 턴 산출물 ${latest.length}개`, latest.map((a) => a.name));
        else if (artifacts.length === 1) resolve("REF_SINGLE_ARTIFACT", `산출물 하나뿐: ${artifacts[0].name}`);
        else if (ctxEmpty) add("REF_NO_CONTEXT", "HIGH", `과거 지시어 '${past}' + 문맥 없음`);
        else add("REF_UNKNOWN", "UNCERTAIN", `과거 지시어 '${past}'의 후보를 셀 수 없음`);
      }
    } else {
      // 일반 지시어(그거/이거/그 X/산출물 안 위치)
      const pool = nounHits.length ? nounHits : artifacts;
      const latest = latestGroup(pool);
      const linkedMulti = linkedTo(detNouns);
      if (latest.length >= 2) add("REF_GROUP_MULTI", "HIGH", `최근 산출 턴의 산출물 ${latest.length}개`, latest.map((a) => a.name));
      else if (linkedMulti.length && !selection) add("REF_NOUN_MULTI", "HIGH", `'${detNouns.join(", ")}'이(가) 문맥의 복수 대상과 연결됨: ${linkedMulti[0]}`);
      else if (linkedMulti.length && selection) resolve("REF_SELECTION", "복수 대상 중 문맥이 선택·확정을 명시");
      else if (latest.length === 1 && new Set(pool.map((a) => a.group)).size === 1)
        resolve(intra && !bare && !determiners.length ? "REF_INTRA_POSITION" : artifacts.some((a) => a.afterSwitch) ? "REF_TOPIC_SWITCH" : "REF_SINGLE_ARTIFACT", `산출물 하나: ${latest[0].name}`);
      else if (latest.length === 1) add("REF_RECENCY_ONLY", "UNCERTAIN", `여러 턴의 산출물 중 최근성만으로 '${latest[0].name}'`, pool.map((a) => a.name));
      else if (detNouns.length && ctxSentences.some((s) => detNouns.some((n) => s.includes(n))) && !multiSentences.length) resolve("REF_SINGLE_ENTITY", `문맥에 '${detNouns.join(", ")}' 대상이 하나`);
      else if (doc && !conv.length) resolve("REF_DOCUMENT", "지시어 + 첨부 문서만 있음");
      else if (intra && !bare && !determiners.length && ctxEmpty) {
        /* '두 번째 문장' 같은 위치 표현 + 문맥 없음: 요청 자체 본문이 있으면 정상 */
      } else if (ctxEmpty) add("REF_NO_CONTEXT", "HIGH", "지시어가 있는데 문맥이 비어 있음");
      else add("REF_UNKNOWN", "UNCERTAIN", "지시어의 후보를 셀 수 없음");
    }
  }

  // ---- 지시어 없이 요청 명사가 문맥의 복수 집합과 연결 (견적서 파일 삭제, 회비 조항 'V'로) ----
  if (!hasDeixis && !explicit && !hasSignal("REF_HOMONYM") && multiSentences.length) {
    const linked = multiSentences.filter((s) => tokensV02(s).some((t) => reqTokens.some((r) => tokMatch(t, r))));
    if (linked.length) {
      const turnOf = turns.find((t) => t.text.includes(linked[0]));
      const by = turnOf ? disambiguatedBy(linked[0], turnOf.text) : null;
      if (selection) resolve("REF_SELECTION", "복수 대상 중 문맥이 선택·확정을 명시");
      else if (by) resolve("REF_DISAMBIGUATED", `복수 대상 중 요청의 '${by}'로 구분`);
      else add("REF_NOUN_MULTI", "HIGH", `요청 명사가 문맥의 복수 대상과 연결됨: ${linked[0]}`);
    }
  }

  // ---- 사용자 미결정 ----
  // v0.2.1: v0.1 처럼 삭제·교체·편집 동작에도 적용 (v0.2.0 은 외부 작업으로만 좁혀 '중복 기준 미정 + 지워줘'를 놓침)
  if (undecided && (hasDeixis || scope !== "none" || linkedTo(reqTokens).length)) add("CTX_UNDECIDED", "HIGH", "문맥에서 사용자가 아직 정하지 않았다고 밝힘");

  // ---- 관점 모호성 ----
  const persp = command.match(PERSPECTIVE);
  if (persp) {
    const parties = new Set<string>();
    for (const m of ctxText.matchAll(PARTY_PAIR)) [m[1], m[4]].forEach((p) => parties.add(p));
    for (const m of ctxText.matchAll(SUBJ_OBJ_PAIR)) [m[1], m[3]].forEach((p) => parties.add(p));
    const multiParty = parties.size >= 2 || PARTY_MARK.test(ctxText);
    const headNamesParty = [...parties].some((p) => p.length >= 2 && persp[1].includes(p));
    if (multiParty && !headNamesParty) add("PERSPECTIVE_MULTI", "HIGH", `'${persp[1]} ${persp[2]}' + 문맥 당사자 2명 이상`);
  }

  // ---- 문맥 인용 속 대명사로만 지칭된 인물 ----
  if (QUOTED_DEICTIC_ROLE.test(ctxText) && ROLE_NOUN.test(command) && ![...command.matchAll(NAMED_PERSON)].length) {
    add("HIDDEN_REFERENT", "HIGH", "문맥에서 '그 …'로만 지칭된 인물을 요청이 서술로 가리킴 — 실제 식별 정보 없음");
  }

  // ---- 비가역 실행 (외부 자원만) ----
  const irreversible = scope === "external";
  if (irreversible) {
    const unresolvedRef = signals.some((s) => s.id.startsWith("REF_") || s.id === "CTX_UNDECIDED" || s.id === "DOC_SPAN_MULTI" || s.id === "HIDDEN_REFERENT");
    const strongEvidence =
      explicit ||
      resolutions.some((r) => ["REF_SELECTION", "REF_SINGLE_ENTITY", "REF_ORDINAL", "REF_NOUN_UNIQUE", "REF_RECENCY_MARKED", "REF_DISAMBIGUATED", "REF_DOCUMENT"].includes(r.id)) ||
      (selection && !undecided);
    if (unresolvedRef) add("IRREV_UNRESOLVED", "HIGH", "외부 비가역 작업 + 대상 후보가 하나로 정해지지 않음");
    else if (strongEvidence) resolve("IRREV_RESOLVED", "외부 비가역 작업이지만 대상 근거가 강함");
    else add("IRREV_WEAK", "UNCERTAIN", "외부 비가역 작업 + 대상 확인 근거가 약함");
  }

  // ---- v0.2.1: 내부 편집이라도 대상이 서술로만 주어진 삭제·교체는 분석으로 (v0.1 의 IRREV_WEAK 안전망 복원) ----
  // 가드 G2 는 여전히 외부 자원에만 발동한다. 이 신호는 "분석할지"만 정하고 질문을 강제하지 않는다.
  if (scope === "internal_edit" && REMOVE_VERB.test(command) && !explicit && !signals.some((s) => s.tier === "HIGH")) {
    const identifying = ["REF_SINGLE_ARTIFACT", "REF_INTRA_POSITION", "REF_ORDINAL", "REF_NOUN_UNIQUE", "REF_RECENCY_MARKED", "REF_SELECTION", "REF_DISAMBIGUATED", "REF_INLINE_PAYLOAD", "REF_TOPIC_SWITCH", "REF_SINGLE_ENTITY", "REF_DOC_SPAN_UNIQUE"];
    if (!resolutions.some((r) => identifying.includes(r.id))) add("EDIT_TARGET_WEAK", "UNCERTAIN", "삭제·교체 대상이 서술로만 주어지고 하나로 확인되지 않음");
  }

  // ---- 핵심 정보 누락 ----
  const openExample = OPEN_EXAMPLE.test(command);
  const ctxHasNumbers = /\d/.test(ctxText);
  const infoTier: RiskTier = ctxEmpty ? "HIGH" : "UNCERTAIN";
  if (INFO_ACTUAL.test(command) && !ctxHasNumbers) add("INFO_ACTUAL_DATA", "HIGH", "'실제' 수치·내역이 핵심인데 문맥에 수치 없음");
  if (INFO_PERSONAL.test(command) && !openExample) add("INFO_PERSONAL", infoTier, "개인·소속 고유 정보가 핵심" + (ctxEmpty ? "인데 문맥 없음" : " — 문맥에 있는지 확인 필요"));
  if (INFO_SELF_REF.test(command)) add("INFO_SELF_REFERENCE", infoTier, "'내가 말한' 정보" + (ctxEmpty ? "가 문맥에 없음" : " — 문맥 확인 필요"));
  if (INFO_LOC.test(command)) add("INFO_LOCATION", infoTier, "근처·동네 장소 정보가 핵심인데 위치" + (ctxEmpty ? " 없음" : " 확인 필요"));
  if (INFO_SCHED.test(command) && !/\d+\s*(월|일|시)/.test(ctxText)) add("INFO_SCHEDULE", infoTier, "일정에 맞춰 달라는데 일정 정보" + (ctxEmpty ? " 없음" : " 확인 필요"));
  if (INFO_ANEC.test(command) && !openExample) add("INFO_ANECDOTE", infoTier, "개인 일화·경험을 넣어 달라는데 내용" + (ctxEmpty ? " 없음" : " 확인 필요"));
  if (INFO_EXPERIENCE.test(command) && !openExample) add("INFO_PERSONAL", infoTier, "본인 경험이 핵심" + (ctxEmpty ? "인데 문맥 없음" : " — 문맥 확인 필요"));
  if (INFO_ORG.test(command) && !openExample) add("INFO_PERSONAL", infoTier, "소속 조직 고유 사실이 핵심" + (ctxEmpty ? "인데 문맥 없음" : " — 문맥 확인 필요"));
  if (INFO_PASTDEC.test(command)) add("INFO_PAST_DECISION", infoTier, "지난 회의 등에서 정한 내용" + (ctxEmpty ? "이 문맥에 없음" : " 확인 필요"));
  if (STRICT_DEGREE.test(command)) {
    if (VALUE_WITH_UNIT.test(request) || VALUE_WITH_UNIT.test(ctxText)) resolve("INFO_IN_CONTEXT", "엄격한 분량 조건의 기준값이 있음");
    else add("DEGREE_STRICT_NO_VALUE", "HIGH", "분량·시간 엄수를 요구하지만 기준값 없음");
  }

  // ---- 비교 기준 ----
  if (COMPARISON.test(command)) {
    let topics = 0;
    for (const u of userCtx) for (const m of u.matchAll(TOPIC)) {
      const w = m[1] ?? m[3];
      if (w && !TOPIC_STOP.has(w)) topics++;
    }
    if (topics >= 2) add("CMP_MULTI", "HIGH", `비교 기준 후보 ${topics}개`);
    else if (topics === 1) resolve("CMP_SINGLE", "비교 기준이 하나");
    else add("CMP_UNKNOWN", "UNCERTAIN", "비교 기준을 문맥에서 찾지 못함");
  }

  const tier = signals.reduce<RiskTier>((t, s) => (TIER_RANK[s.tier] > TIER_RANK[t] ? s.tier : t), "LOW");
  let route: Route = tier === "HIGH" ? "B_ANALYZE" : tier === "UNCERTAIN" ? "C_UNCERTAIN" : "A_DIRECT";
  if (route === "A_DIRECT" && irreversible && opts.irreversibleResolvedRoute === "C_UNCERTAIN") route = "C_UNCERTAIN";

  return { router_version: ROUTER_V02_VERSION, tier, route, scope, irreversible, signals, resolutions, artifacts, deixis };
}
