// V3 실험 — 결정론적 모호성 "위험" 라우터 (LLM 미사용, 추가 API 비용 0).
//
// 목적: 요청마다 V2 정밀 분석(LLM 1회)을 부를지 판단한다. 위험 "탐지"만 하며, 질문 여부는 정하지 않는다.
//   - LOW       → 경로 A: 정밀 분석 생략 (Direct 처리와 같은 결과)
//   - HIGH      → 경로 B: V2 정밀 분석 + 결정론적 안전 가드
//   - UNCERTAIN → 경로 C: 위험 판단 자체가 불확실 → 기본 정책은 정밀 분석(질문을 만들지 여부는 분석이 결정)
//
// 위험 등급 정의 (signal 하나라도 해당하면 그 등급, 여럿이면 가장 높은 등급):
//   HIGH      : 문맥에서 구조적으로 확인되는 "여러 후보" 또는 "핵심 정보 부재"
//               (지시 대상 후보 2개 이상, 사용자가 미결정이라고 밝힘, 대상이 확정되지 않은 비가역 실행,
//                개인·실제 데이터 누락, 기준값 없는 엄격한 분량 조건, 비교 기준 후보 2개 이상)
//   UNCERTAIN : 위험 표지는 있으나 라우터가 후보 수를 확정할 수 없음
//               (지시어의 후보를 셀 수 없음, 최근성만으로 고른 대상, 대상 근거가 약한 비가역 실행 등)
//   LOW       : 위험 표지가 없거나, 있던 표지가 문맥에서 결정론적으로 하나로 해소됨
//
// 기존 분류 체계와의 관계: 라우터 signal 은 V2 의 모호성 유형(reference/omission/degree/comparison/scope)을
// 대체하지 않는다. V2 분석기·DecisionEngine 은 그대로 쓰고, 라우터는 그 앞단에서 "분석할지"만 정한다.
// 한계: 한국어 표면 표현 규칙이라 문맥 의존 모호성(예: 재서술된 대상, 대명사가 문맥 속에만 있는 경우)을
// 놓칠 수 있다. 그래서 확신할 수 없는 경우는 LOW 가 아니라 UNCERTAIN 으로 보낸다.

export type RiskTier = "LOW" | "UNCERTAIN" | "HIGH";
export type Route = "A_DIRECT" | "B_ANALYZE" | "C_UNCERTAIN";

export type SignalId =
  | "REF_GROUP_MULTI" // 가장 최근 산출 턴에서 산출물이 2개 이상 + 지시어 (HIGH, 가드 G1b)
  | "REF_PAST_MULTI" // 과거 지시어(아까·전에·앞에서) + 이전 산출물 2개 이상 + 명시 명사 없음 (HIGH, 가드 G1a)
  | "REF_NOUN_MULTI" // 요청 명사가 문맥의 복수 집합(두 개·둘 다·A랑 B)과 연결되고 구분 근거 없음 (HIGH)
  | "REF_PERSON_MULTI" // 인물 지시(그분·그 사람) + 문맥에 인물 2명 이상 (HIGH)
  | "REF_NO_CONTEXT" // 지시어가 있는데 문맥(대화·문서)이 비어 있음 (HIGH)
  | "REF_UNKNOWN" // 지시어가 있으나 후보 수를 확정할 수 없음 (UNCERTAIN)
  | "REF_RECENCY_ONLY" // 같은 종류 산출물이 여러 턴에 있고 최근성만으로 고름 (UNCERTAIN)
  | "REF_PAST_SINGLE" // 과거 지시어 + 이전 산출물 1개 (UNCERTAIN)
  | "CTX_UNDECIDED" // 사용자가 문맥에서 아직 정하지 않았다고 밝힘 (HIGH, 가드 G3)
  | "IRREV_UNRESOLVED" // 비가역 실행 + 대상 후보 여러 개 (HIGH)
  | "IRREV_WEAK" // 비가역 실행 + 대상 확인 근거 약함 (UNCERTAIN, 가드 G2)
  | "INFO_PERSONAL" // 개인·소속 고유 정보가 핵심인데 문맥 없음 (HIGH; 문맥이 있으면 UNCERTAIN)
  | "INFO_ACTUAL_DATA" // '실제' 수치·내역이 핵심인데 문맥에 수치 없음 (HIGH)
  | "INFO_SELF_REFERENCE" // "내가 말한/지난번에 말한" 정보가 문맥에 없음 (HIGH; 문맥이 있으면 UNCERTAIN)
  | "DEGREE_STRICT_NO_VALUE" // 분량·시간 엄수를 요구하지만 기준값 없음 (HIGH)
  | "CMP_MULTI" // 비교 표현 + 기준 후보 2개 이상 (HIGH)
  | "CMP_UNKNOWN"; // 비교 표현 + 기준을 문맥에서 찾지 못함 (UNCERTAIN)

export type ResolutionId =
  | "REF_EXPLICIT" // 파일명·인용·번호·고유 이름으로 대상 명시
  | "REF_NOUN_UNIQUE" // 요청 명사가 산출물 하나와만 일치
  | "REF_RECENCY_MARKED" // '방금·가장 최근' 표지로 최근 산출물 하나
  | "REF_ORDINAL" // '두 번째·처음에 쓴' 서수로 하나
  | "REF_SINGLE_ARTIFACT" // 문맥 산출물이 하나뿐
  | "REF_TOPIC_SWITCH" // '이제 X 하자' 전환 뒤 산출물 하나
  | "REF_DOCUMENT" // '이 문서' + 첨부 문서
  | "REF_SELECTION" // 문맥이 선택·확정·불필요를 명시 (정했어·확정본·필요 없어졌어)
  | "REF_SINGLE_ENTITY" // 문맥에 해당 대상이 하나만 (인용된 이름 1개 등)
  | "IRREV_RESOLVED" // 비가역 실행이지만 대상 근거가 강함
  | "CMP_SINGLE" // 비교 기준이 하나
  | "INFO_IN_CONTEXT"; // 필요한 정보가 요청·문맥에 있음

export interface RiskSignal {
  id: SignalId;
  tier: RiskTier;
  detail: string;
  candidates?: string[];
}
export interface Resolution {
  id: ResolutionId;
  detail: string;
}
export interface Artifact {
  name: string; // 산출물 이름 (예: "환영 메일", "메일#1")
  noun: string; // 비교용 핵심 명사
  turn: number; // 대화 내 위치
  group: number; // 같은 assistant 턴에서 함께 만든 산출물 묶음 번호
  afterSwitch: boolean; // "이제 X 하자" 전환 이후 산출물인지
}
export interface RiskAssessment {
  router_version: "v3-router-0.1";
  tier: RiskTier;
  route: Route;
  irreversible: boolean;
  signals: RiskSignal[];
  resolutions: Resolution[];
  artifacts: Artifact[];
  deixis: string[];
}

export interface RouterInput {
  current_user_request: string;
  recent_conversation?: string[];
  document_context?: string;
}

// ---------------- 어휘 ----------------

const TIER_RANK: Record<RiskTier, number> = { LOW: 0, UNCERTAIN: 1, HIGH: 2 };

// 지시 표현
const BARE_DEMONSTRATIVE = /(?:^|[\s"'(])(그거|그것|이거|이것|저거|저것|그걸|이걸|그게|이게)(?=[\s,.!?을를이가은는도만에]|$)/;
const DETERMINER_NOUN = /(?:^|\s)(그|이|저|해당)\s+([가-힣A-Za-z0-9_]+)/g;
const SURNAME_TITLE = /^(과장님|대리님|교수님|선생님|팀장님|부장님|사원|주임|선배|후배|님|씨)/;
const PERSON_DEIXIS = /(그분|이분|저분|그\s*사람|그\s*친구|그\s*선배|그\s*후배|그\s*교수님|그\s*선생님)/;
const PAST_DEIXIS = /(아까|전에|이전에|예전에|앞에서|앞서|위에서|위의|저번에|지난번에?)/;
const RECENCY_MARKER = /(방금|가장\s*최근|마지막으로|바로\s*전|지금\s*막|최근에\s*만든)/;
const ORDINAL = /(첫\s*번째|두\s*번째|세\s*번째|네\s*번째|처음에\s*(쓴|만든|작성한|정한)|마지막에\s*(쓴|만든|작성한)|(\d+)\s*번째)/;
const ORDINAL_VALUE: Array<[RegExp, number | "last"]> = [
  [/첫\s*번째|처음에/, 1],
  [/두\s*번째/, 2],
  [/세\s*번째/, 3],
  [/네\s*번째/, 4],
  [/마지막에/, "last"],
];
const EXPLICIT_ID = /([\w가-힣\-]+\.(xlsx|xls|docx|doc|pptx|ppt|pdf|hwp|txt|csv|png|jpg|zip|md))|(\d+\s*번\s*(항목|슬라이드|문단|조|줄|행|안))|(제?\d+조)|(\d+안)|([A-Z]안)/i;
const QUOTED = /'([^']+)'|"([^"]+)"|‘([^’]+)’|“([^”]+)”|「([^」]+)」/g;
const NAMED_PERSON = /([가-힣]{2,4})\s*(님|씨)/g;

// 비가역 실행
const IRREV = /(삭제|지워|지우|제거|없애|폐기|덮어|교체|대체|빼\s?줘|빼\s?주|발송|보내\s?줘|보내\s?주|전송|게시|올려\s?줘|공개해|해지|탈퇴|취소해|취소\s?해)/;
const DRAFT_ONLY = /((?<!덮어)써\s?줘|작성해\s?줘|만들어\s?줘)/;
const DISPATCH = /(보내\s?줘|발송해|게시해|올려\s?줘|공개해|전송해)/;
const INFORMATIONAL = /(방법|어떻게|설명해|알려\s?줘|뭐야|차이|의미)/;

// 문맥 상태
const MULTI = /((두|세|네|여러)\s*(개|가지|군데|분|명|건|장|종류|곳|편|번)|둘\s*(다|중|모두)|하나는.*하나는|중\s*하나)/;
const QUOTED_PAIR = /['"‘“][^'"’”]+['"’”]\s*(와|과|랑|이랑|하고|,)\s*['"‘“][^'"’”]+['"’”]/;
const PERSON_PAIR = /([가-힣]{1,4}\s?[가-힣]{0,3}님)\s*(이랑|랑|과|와|하고)\s*([가-힣]{1,4}\s?[가-힣]{0,3}님)|((팀장님|선배|후배|교수님|조교님|과장님|대리님)\S*\s*(과|와|이랑|랑|하고)\s*\S+)/;
const SELECTION = /((으로|로)\s*(가기로\s*)?(정했|확정)|확정본|최종\s*확정|필요\s*없(어|어졌|음)|아무도\s*안\s*써|만\s*(아직\s*)?남(았|아)|이미\s*보냈|삭제\s*대상으로|하나만\s*(아직|남))/;
const UNDECIDED = /((아직|미처)\s*(안|못)\s*(정했|정해|확인|결정)|(아직|미처)\s*\S*\s*(정하지|확인하지|결정하지|확인\s*못|확인\s*안|못\s*정|안\s*정)|고민\s*중|정하지\s*못|모르겠|어느\s*(쪽|것|걸|게)인지|어디를\s*\S*\s*할지|확정\s*(안|못)|중\s*하나로\s*할\s*것\s*같|할지\s*\S*\s*할지)/;
const TOPIC_SWITCH = /이제\s+.+?(쓰자|하자|만들자|넘어가자|해보자|작성하자|짜자)/;
const PRODUCTION = /^(.+?)(을|를)\s*(작성|만들|제안|정리|구성|짜|작성해|만들어)\S*\s*(했|드렸|었)/;
const MODIFICATION = /(추가|수정|변경|반영|삭제)했습니다/;

// 정보 누락
const INFO_NOUNS = "(졸업\\s*작품|주제|성적|성적표|전공|경력|이력|실적|매출|지출|내역|경험|포트폴리오|주소|위치|근처|점수|연봉|수상|자격증|업무|일정|날짜|자기소개서|성장\\s*과정)";
const INFO_PERSONAL = new RegExp(`(^|\\s)(내|나의|제|저의|우리\\s*[가-힣]{0,6})\\s*([가-힣\\s]{0,12}?)${INFO_NOUNS}`);
const INFO_ACTUAL = /실제(로)?\s*(\S+\s*){0,3}?(수치|매출|지출|비용|내역|금액|데이터|기록|성적|결과)/;
const INFO_SELF_REF = /(내가|제가|저번에|지난번에)\s*(\S+\s*)?(말한|얘기한|알려준|정한|적은|보낸|말했던)/;
const OPEN_EXAMPLE = /(예시|샘플|아이디어|템플릿|양식|후보|추천|이름\s*지어|브레인스토밍)/;
const STRICT_DEGREE = /((딱|정확히|꼭|반드시|엄격히)\s*\S*\s*(맞춰|맞게|지켜))|((분량|글자\s*수|자수|길이|시간|규정|제한)\S*\s*(에\s*)?(딱|정확히|꼭)?\s*(맞춰|맞게|지켜))/;
const VALUE_WITH_UNIT = /\d+\s*(자|분|쪽|페이지|단어|줄|장|초|매|시간)/;

// 비교
const COMPARISON = /(전처럼|예전처럼|지난번처럼|아까처럼|저번처럼|예전\s*거(랑|와)\s*비슷|같은\s*(톤|스타일|느낌|형식)|비슷한\s*(톤|스타일|느낌))/;
const PAST_STANDARD = /(작년|재작년|지난|이전|예전|저번|전\s*학기|그\s*전)\S*.*?(톤|스타일|형식|방식|느낌|구성|시작|문장|도입)/;

const PARTICLES = /(은|는|이|가|을|를|에|에서|에게|께|로|으로|와|과|랑|이랑|도|만|의|야|이야|요)$/;
const STOP = new Set(["지금", "해줘", "줘", "좀", "더", "이번", "오늘", "내일", "다시", "모두", "전체", "그", "이", "저", "거", "것", "하나", "두", "둘", "있어", "했어", "다음"]);
const NOUN_ENDING_EXCEPTIONS = ["결과", "효과", "성과", "교과", "학과", "부과"];

// ---------------- 유틸 ----------------

function stripQuotedPayload(request: string): string {
  // "아래 문장을 ~ 바꿔줘: <payload>" 의 payload 와 인용문은 명령이 아니라 작업 재료이므로 제외
  let s = request.replace(/(문장|문구|글|다음|아래|이것)[^:：]*[:：][\s\S]*$/, (m) => m.split(/[:：]/)[0]);
  s = s.replace(QUOTED, " ");
  return s;
}

function tokens(text: string): string[] {
  return text
    .replace(/[^가-힣A-Za-z0-9_\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(PARTICLES, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function parseTurns(conv: string[]) {
  return conv.map((raw, i) => {
    const m = raw.match(/^\s*(User|Assistant|사용자|어시스턴트)\s*[:：]\s*([\s\S]*)$/i);
    const role = m ? (/^(user|사용자)$/i.test(m[1]) ? "user" : "assistant") : "unknown";
    return { i, role, text: (m ? m[2] : raw).trim() };
  });
}

function splitConjunction(phrase: string): string[] {
  // "대본과 예상 답변" → ["대본", "예상 답변"] (결과·효과처럼 '과/와'로 끝나는 명사는 분리하지 않음)
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
  return parts.filter(Boolean);
}

export function extractArtifacts(conv: string[]): Artifact[] {
  const turns = parseTurns(conv);
  const switchIdx = Math.max(-1, ...turns.filter((t) => t.role === "user" && TOPIC_SWITCH.test(t.text)).map((t) => t.i));
  const out: Artifact[] = [];
  let group = 0;
  for (const t of turns) {
    if (t.role !== "assistant" || MODIFICATION.test(t.text)) continue;
    const m = t.text.match(PRODUCTION);
    if (!m) continue;
    let phrase = m[1].replace(/^(제가|네,?|알겠습니다\.?)\s*/, "").trim();
    group++;
    const plural = phrase.match(/^(두|세|네)\s+(.+)$/);
    if (plural) {
      const n = { 두: 2, 세: 3, 네: 4 }[plural[1] as "두" | "세" | "네"];
      for (let k = 1; k <= n; k++) out.push({ name: `${plural[2]}#${k}`, noun: plural[2], turn: t.i, group, afterSwitch: switchIdx >= 0 && t.i > switchIdx });
      continue;
    }
    for (const p of splitConjunction(phrase)) out.push({ name: p, noun: p, turn: t.i, group, afterSwitch: switchIdx >= 0 && t.i > switchIdx });
  }
  // 전환이 있었다면 전환 이전 산출물은 지시어 후보에서 제외 (V1 최근성 규칙과 같은 취지)
  if (switchIdx >= 0 && out.some((a) => a.afterSwitch)) return out.filter((a) => a.afterSwitch);
  return out;
}

function nounMatches(artifacts: Artifact[], requestText: string): Artifact[] {
  const req = requestText.replace(/\s+/g, "");
  return artifacts.filter((a) => {
    const n = a.noun.replace(/\s+/g, "");
    if (n.length >= 2 && req.includes(n)) return true;
    // 마지막 단어 일치 (예: "비용 표" ↔ "표"는 너무 짧아 제외, "소개 문구" ↔ "문구")
    const last = a.noun.trim().split(/\s+/).pop() ?? "";
    return last.length >= 2 && req.includes(last);
  });
}

function latestGroup(artifacts: Artifact[]): Artifact[] {
  if (!artifacts.length) return [];
  const g = Math.max(...artifacts.map((a) => a.group));
  return artifacts.filter((a) => a.group === g);
}

function ordinalIndex(text: string): number | "last" | null {
  for (const [re, v] of ORDINAL_VALUE) if (re.test(text)) return v;
  const m = text.match(/(\d+)\s*번째/);
  return m ? Number(m[1]) : null;
}

// ---------------- 평가 ----------------

export interface RouterOptions {
  /** 대상 근거가 강한 비가역 실행을 어디로 보낼지. 기본 A(Direct). 보수적으로 운영하려면 C. */
  irreversibleResolvedRoute?: "A_DIRECT" | "C_UNCERTAIN";
}

export function assessRisk(input: RouterInput, opts: RouterOptions = {}): RiskAssessment {
  const request = input.current_user_request.trim();
  const conv = (input.recent_conversation ?? []).filter((t) => t.trim());
  const doc = (input.document_context ?? "").trim();
  const ctxText = [...conv, doc].join("\n");
  const ctxEmpty = !conv.length && !doc;
  const command = stripQuotedPayload(request);
  const artifacts = extractArtifacts(conv);
  const signals: RiskSignal[] = [];
  const resolutions: Resolution[] = [];
  const deixis: string[] = [];
  const add = (id: SignalId, tier: RiskTier, detail: string, candidates?: string[]) => signals.push({ id, tier, detail, candidates });
  const resolve = (id: ResolutionId, detail: string) => resolutions.push({ id, detail });

  // 마침표는 뒤에 공백·끝이 올 때만 문장 경계로 본다 ('견적서.xlsx' 같은 파일명에서 자르지 않음)
  const ctxSentences = ctxText.split(/\n+|[.!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean);
  const multiSentences = ctxSentences.filter((s) => MULTI.test(s) || QUOTED_PAIR.test(s) || PERSON_PAIR.test(s));
  const selection = SELECTION.test(ctxText);
  const undecided = UNDECIDED.test(ctxText);
  const reqTokens = tokens(command);

  // ---- 명시적 대상 ----
  const quotedInReq = [...request.matchAll(QUOTED)].map((m) => m.slice(1).find(Boolean)!).filter(Boolean);
  let explicit = EXPLICIT_ID.test(request) || quotedInReq.length > 0;
  for (const m of command.matchAll(NAMED_PERSON)) {
    const name = m[1];
    const occurrences = ctxText.split(name).length - 1;
    if (occurrences === 1) explicit = true;
  }
  if (explicit) resolve("REF_EXPLICIT", "파일명·인용·번호·고유 이름으로 대상 명시");

  // ---- 지시어 ----
  const bare = command.match(BARE_DEMONSTRATIVE)?.[1];
  const determiners = [...command.matchAll(DETERMINER_NOUN)]
    .filter((m) => !(m[1] === "이" && SURNAME_TITLE.test(m[2])))
    .map((m) => ({ det: m[1], noun: m[2].replace(PARTICLES, "") }));
  const person = command.match(PERSON_DEIXIS)?.[1];
  const past = command.match(PAST_DEIXIS)?.[1];
  const recency = command.match(RECENCY_MARKER)?.[1];
  const ordinal = command.match(ORDINAL)?.[0];
  if (bare) deixis.push(bare);
  for (const d of determiners) deixis.push(`${d.det} ${d.noun}`);
  if (person) deixis.push(person);
  if (past) deixis.push(past);
  if (recency) deixis.push(recency);
  if (ordinal) deixis.push(ordinal);
  const hasDeixis = deixis.length > 0;


  const nounHits = nounMatches(artifacts, command);

  if (hasDeixis && !explicit) {
    const docDet = determiners.find((d) => /^(문서|자료|파일|글|보고서)/.test(d.noun) && d.det !== "그") ?? (doc && /이\s*(문서|자료)/.test(command) ? { det: "이", noun: "문서" } : undefined);
    if (person) {
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
      if (latest.length === 1) {

        resolve("REF_RECENCY_MARKED", `'${recency}' → ${latest[0].name}`);
      } else if (latest.length >= 2) add("REF_GROUP_MULTI", "HIGH", `'${recency}' 산출 턴의 산출물 ${latest.length}개`, latest.map((a) => a.name));
      else add("REF_UNKNOWN", "UNCERTAIN", `'${recency}'가 가리킬 산출물을 찾지 못함`);
    } else if (nounHits.length === 1) {

      resolve("REF_NOUN_UNIQUE", `요청 명사가 산출물 '${nounHits[0].name}' 하나와 일치`);
    } else if (past && !determiners.length && nounHits.length === 0) {
      const latestG = artifacts.length ? Math.max(...artifacts.map((a) => a.group)) : 0;
      const earlier = artifacts.filter((a) => a.group !== latestG);
      if (earlier.length >= 2) add("REF_PAST_MULTI", "HIGH", `과거 지시어 '${past}' + 이전 산출물 ${earlier.length}개`, earlier.map((a) => a.name));
      else if (earlier.length === 1) add("REF_PAST_SINGLE", "UNCERTAIN", `과거 지시어 '${past}' + 이전 산출물 1개`, earlier.map((a) => a.name));
      else if (artifacts.length === 1) {

        resolve("REF_SINGLE_ARTIFACT", `산출물 하나뿐: ${artifacts[0].name}`);
      } else if (ctxEmpty) add("REF_NO_CONTEXT", "HIGH", `과거 지시어 '${past}' + 문맥 없음`);
      else add("REF_UNKNOWN", "UNCERTAIN", `과거 지시어 '${past}'의 후보를 셀 수 없음`);
    } else {
      // 일반 지시어(그거/이거/그 X): 같은 명사 산출물 → 최근 산출 턴 → 복수 집합 순으로 확인
      const pool = nounHits.length ? nounHits : artifacts;
      const latest = latestGroup(pool);
      const detNouns = determiners.map((d) => d.noun);
      const linkedMulti = multiSentences.filter((s) => detNouns.some((n) => n.length >= 1 && tokens(s).some((t) => t.startsWith(n) || n.startsWith(t))));
      if (latest.length >= 2) add("REF_GROUP_MULTI", "HIGH", `최근 산출 턴의 산출물 ${latest.length}개`, latest.map((a) => a.name));
      else if (linkedMulti.length && !selection) add("REF_NOUN_MULTI", "HIGH", `'${detNouns.join(", ")}'이(가) 문맥의 복수 대상과 연결됨: ${linkedMulti[0]}`);
      else if (linkedMulti.length && selection) {

        resolve("REF_SELECTION", "복수 대상 중 문맥이 선택·확정을 명시");
      } else if (latest.length === 1 && new Set(pool.map((a) => a.group)).size === 1) {

        resolve(artifacts.some((a) => a.afterSwitch) ? "REF_TOPIC_SWITCH" : "REF_SINGLE_ARTIFACT", `산출물 하나: ${latest[0].name}`);
      } else if (latest.length === 1) add("REF_RECENCY_ONLY", "UNCERTAIN", `여러 턴의 산출물 중 최근성만으로 '${latest[0].name}'`, pool.map((a) => a.name));
      else if (detNouns.length && ctxSentences.some((s) => detNouns.some((n) => s.includes(n))) && !multiSentences.length) {

        resolve("REF_SINGLE_ENTITY", `문맥에 '${detNouns.join(", ")}' 대상이 하나`);
      } else if (doc && !conv.length) {

        resolve("REF_DOCUMENT", "지시어 + 첨부 문서만 있음");
      } else if (ctxEmpty) add("REF_NO_CONTEXT", "HIGH", "지시어가 있는데 문맥이 비어 있음");
      else add("REF_UNKNOWN", "UNCERTAIN", "지시어의 후보를 셀 수 없음");
    }
  }

  // ---- 지시어 없이 요청 명사가 문맥의 복수 집합과 연결 (예: '견적서 파일 삭제해줘' + 두 개) ----
  if (!hasDeixis && !explicit && multiSentences.length) {
    const linked = multiSentences.filter((s) => tokens(s).some((t) => reqTokens.includes(t)));
    if (linked.length && !selection) add("REF_NOUN_MULTI", "HIGH", `요청 명사가 문맥의 복수 대상과 연결됨: ${linked[0]}`);
    else if (linked.length && selection) {

      resolve("REF_SELECTION", "복수 대상 중 문맥이 선택·확정을 명시");
    }
  }

  // ---- 사용자가 미결정이라고 밝힘 ----
  if (undecided && (hasDeixis || IRREV.test(command) || multiSentences.some((s) => tokens(s).some((t) => reqTokens.includes(t))))) {
    add("CTX_UNDECIDED", "HIGH", "문맥에서 사용자가 아직 정하지 않았다고 밝힘");
  }

  // ---- 비가역 실행 ----
  const irreversible = IRREV.test(command) && !(INFORMATIONAL.test(command) && !DISPATCH.test(command)) && !(DRAFT_ONLY.test(command) && !DISPATCH.test(command));
  if (irreversible) {
    const unresolvedRef = signals.some((s) => s.id.startsWith("REF_") || s.id === "CTX_UNDECIDED");
    const strongEvidence = explicit || resolutions.some((r) => ["REF_SELECTION", "REF_SINGLE_ENTITY", "REF_ORDINAL", "REF_NOUN_UNIQUE", "REF_RECENCY_MARKED"].includes(r.id)) || (selection && !undecided);
    if (unresolvedRef) add("IRREV_UNRESOLVED", "HIGH", "비가역 실행 + 대상 후보가 하나로 정해지지 않음");
    else if (strongEvidence) resolve("IRREV_RESOLVED", "비가역 실행이지만 대상 근거가 강함");
    else add("IRREV_WEAK", "UNCERTAIN", "비가역 실행 + 대상 확인 근거가 약함 (서술형 대상·단일 후보 추정)");
  }

  // ---- 핵심 정보 누락 ----
  const openExample = OPEN_EXAMPLE.test(command);
  const ctxHasNumbers = /\d/.test(ctxText);
  if (INFO_ACTUAL.test(command) && !ctxHasNumbers) add("INFO_ACTUAL_DATA", "HIGH", "'실제' 수치·내역이 핵심인데 문맥에 수치 없음");
  if (INFO_PERSONAL.test(command) && !openExample) {
    if (ctxEmpty) add("INFO_PERSONAL", "HIGH", "개인·소속 고유 정보가 핵심인데 문맥 없음");
    else add("INFO_PERSONAL", "UNCERTAIN", "개인·소속 고유 정보 — 문맥에 있는지 확인 필요");
  }
  if (INFO_SELF_REF.test(command)) {
    if (ctxEmpty) add("INFO_SELF_REFERENCE", "HIGH", "'내가 말한' 정보가 문맥에 없음");
    else add("INFO_SELF_REFERENCE", "UNCERTAIN", "'내가 말한' 정보 — 문맥에 있는지 확인 필요");
  }
  if (STRICT_DEGREE.test(command)) {
    if (VALUE_WITH_UNIT.test(request) || VALUE_WITH_UNIT.test(ctxText)) resolve("INFO_IN_CONTEXT", "엄격한 분량 조건의 기준값이 있음");
    else add("DEGREE_STRICT_NO_VALUE", "HIGH", "분량·시간 엄수를 요구하지만 기준값 없음");
  }

  // ---- 비교 기준 ----
  if (COMPARISON.test(command)) {
    const standards = conv.filter((t) => /^\s*(User|사용자)/i.test(t) && PAST_STANDARD.test(t));
    if (standards.length >= 2) add("CMP_MULTI", "HIGH", `비교 기준 후보 ${standards.length}개`);
    else if (standards.length === 1) resolve("CMP_SINGLE", "비교 기준이 하나");
    else add("CMP_UNKNOWN", "UNCERTAIN", "비교 기준을 문맥에서 찾지 못함");
  }

  const tier = signals.reduce<RiskTier>((t, s) => (TIER_RANK[s.tier] > TIER_RANK[t] ? s.tier : t), "LOW");
  let route: Route = tier === "HIGH" ? "B_ANALYZE" : tier === "UNCERTAIN" ? "C_UNCERTAIN" : "A_DIRECT";
  if (route === "A_DIRECT" && irreversible && opts.irreversibleResolvedRoute === "C_UNCERTAIN") route = "C_UNCERTAIN";

  return { router_version: "v3-router-0.1", tier, route, irreversible, signals, resolutions, artifacts, deixis };
}
