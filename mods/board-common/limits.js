// 보드 모드들이 같이 쓰는 상한 상수. 값이 어긋나지 않도록 여기 한곳에만 둡니다.
// (board-picker/sessions.py의 세션 상한은 main.js가 PICKER_SESSION_LIMIT을 인자로 넘깁니다.)

// git status 항목 상한: board-changes 최대 표시 수 = board-files marks 상한
export const STATUS_LIMIT = 5000;
// 목록 처음 표시 개수와 "+N개 더" 한 번에 늘리는 개수
export const LIST_INITIAL = 200;
export const LIST_STEP = 1000;
// 이 개수를 넘을 때만 가상 스크롤로 그립니다(적은 목록은 기존 화면 그대로).
export const VIRTUAL_MIN_ROWS = 100;

// board-preview: 읽기 단계 용량 상한(문자/바이트)과 diff 행 상한
export const DIFF_MAX_CHARS = 400000;
export const DIFF_MAX_LINES = 5000;

// board-files: 폴더당/전체 항목 상한, 경로별 펼침 상태 LRU 상한
export const FILES_PER_FOLDER = 500;
export const FILES_TOTAL = STATUS_LIMIT;
export const FILES_SAVED_LIMIT = 20;

// board-picker: 최근 세션 상한(한 번에 더 불러오는 개수도 같음)
export const PICKER_SESSION_LIMIT = 200;

// board 카드 열: 이 개수를 넘는 열만 가상 스크롤
export const BOARD_VIRTUAL_MIN_CARDS = 40;

// git status 공유 캐시 수명(ms)과 다른 모드의 실행 중 표시 유효 시간
export const STATUS_TTL = 5000;
export const STATUS_PENDING_TTL = 15000;
