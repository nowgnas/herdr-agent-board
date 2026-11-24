// board-preview diff 파싱·하이라이트·절단 순수 로직 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines, highlightTokens, segmentsOf, truncateText, utf8Length, limitLines, diffView, longestLine, textCells, maxScrollX, CELL_EM } from "../mods/board-preview/diff.js";

const SAMPLE = [
  "diff --git a/x.js b/x.js",
  "index 111..222 100644",
  "--- a/x.js",
  "+++ b/x.js",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-let b = \"old\";",
  "+let b = \"new\"; // 변경",
  "\\ No newline at end of file",
  "",
].join("\n");

test("parseDiffLines: 헤더 제거와 old/new 줄 번호 추적(기존 동작)", () => {
  const out = parseDiffLines(SAMPLE);
  assert.deepEqual(out.map(l => l.type), ["hunk", "context", "remove", "add", "meta"]);
  assert.equal(out[1].oldLine, 1); assert.equal(out[1].newLine, 1);
  assert.equal(out[2].oldLine, 2); assert.equal(out[2].newLine, undefined);
  assert.equal(out[3].newLine, 2); assert.equal(out[3].text, "let b = \"new\"; // 변경");
});

test("highlightTokens: 테마와 무관한 kind 세그먼트, 원문을 그대로 덮는다", () => {
  const line = "let b = \"new\"; // 변경 42 Foo bar(";
  const segs = highlightTokens(line, "js");
  assert.equal(segs.map(s => s.text).join(""), line);
  const kinds = Object.fromEntries(segs.filter(s => s.kind).map(s => [s.text, s.kind]));
  assert.equal(kinds["let"], "keyword");
  assert.equal(kinds['"new"'], "string");
  assert.equal(kinds["// 변경 42 Foo bar("], "comment");
  assert.equal(highlightTokens("# hi", "py")[0].kind, "comment");
  assert.equal(highlightTokens("x 12", "md").find(s => s.text === "12").kind, "number");
});

test("segmentsOf: 한 줄의 하이라이트는 한 번만 계산해 줄 객체에 캐시한다", () => {
  const line = { type: "add", text: "return foo(1);" };
  const first = segmentsOf(line, "js");
  const second = segmentsOf(line, "js");
  assert.equal(first, second); // 같은 배열 객체 = 재계산 없음
  assert.ok(first.some(s => s.kind === "keyword"));
});

test("truncateText/utf8Length: 읽기 상한과 잘림 표시", () => {
  assert.equal(utf8Length("aé한😀"), 1 + 2 + 3 + 4);
  const small = truncateText("abc\ndef", 100);
  assert.deepEqual(small, { text: "abc\ndef", truncated: false });
  const big = truncateText("line1\nline2\nline3-partial", 14);
  assert.equal(big.truncated, true);
  assert.equal(big.text, "line1\nline2\n"); // 마지막 반쪽 줄은 버린다
  const noNewline = truncateText("x".repeat(50), 10);
  assert.equal(noNewline.text, "x".repeat(10));
});

test("limitLines: 행 상한과 남은 줄 수", () => {
  const lines = Array.from({ length: 12000 }, (_, i) => ({ type: "context", text: String(i) }));
  const r = limitLines(lines, 5000);
  assert.equal(r.shown.length, 5000);
  assert.equal(r.hidden, 7000);
  assert.equal(limitLines(lines.slice(0, 3), 5000).hidden, 0);
});

test("diffView: 큰 diff도 렌더 대상은 보이는 행뿐이고 하이라이트도 그 행만", () => {
  const body = Array.from({ length: 30000 }, (_, i) => `+const v${i} = "${i}";`).join("\n");
  const lines = parseDiffLines(`@@ -0,0 +1,30000 @@\n${body}\n`);
  assert.equal(lines.length, 30001);
  const view = diffView(lines, { limit: 5000, rowHeight: 17, viewport: 680, scroll: 17 * 1000, overscan: 5, ext: "js" });
  assert.equal(view.hidden, 30001 - 5000);
  assert.ok(view.rows.length <= 40 + 10, `rows=${view.rows.length}`);
  assert.equal(view.rows[0].item, lines[995]);
  const highlighted = lines.filter(l => l.segs).length;
  assert.equal(highlighted, view.rows.length);
});

test("textCells: ASCII 1칸, 한글·한자·전각·이모지 2칸, 기타 비ASCII 1.5칸, 탭 4칸", () => {
  assert.equal(textCells("abc"), 3);
  assert.equal(textCells("한글"), 4);
  assert.equal(textCells("漢字ｶﾅＡ"), 2 + 2 + 1.5 + 1.5 + 2); // 반각 가타카나는 전각 아님
  assert.equal(textCells("é"), 1.5);
  assert.equal(textCells("\t"), 4);
  assert.equal(textCells("😀"), 2);
});

test("longestLine: 글자 수가 아니라 화면 칸 수로 가장 넓은 줄", () => {
  const lines = [{ text: "a".repeat(300) }, { text: "가".repeat(200) }, { text: "\t".repeat(10) }];
  assert.equal(longestLine(lines), 400);
  assert.equal(longestLine(lines, 1), 300);
});

test("maxScrollX: 한글 200자 줄도 오른쪽 끝까지 스크롤 범위가 충분하다", () => {
  const fontSize = 12, gutter = 100, width = 800;
  const cells = longestLine([{ text: "가".repeat(200) }]);
  const max = maxScrollX({ cells, fontSize, gutter, width });
  // 한글 글리프는 보통 1em(=12px) 폭: 실제 내용 끝(100 + 200*12)이 보이는 위치까지 갈 수 있어야 함
  assert.ok(max + width >= gutter + 200 * fontSize, `max=${max}`);
  assert.ok(max > 200 * 7.3 + gutter - width, "예전 고정 7.3px 추정보다 넓다");
  // 글꼴 크기가 커지면 범위도 커진다
  assert.ok(maxScrollX({ cells, fontSize: 16, gutter, width }) > max);
  // ASCII는 고정폭 0.6em보다 넉넉
  assert.ok(maxScrollX({ cells: 300, fontSize, gutter, width }) + width >= gutter + 300 * fontSize * 0.6);
  assert.ok(CELL_EM >= 0.6);
  assert.equal(maxScrollX({ cells: 10, fontSize, gutter, width }), 0);
});
