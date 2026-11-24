// 언어 토글(ko/en) — shared("board.lang")에 저장되어 모든 모드가 같은 값을 본다.
// 기본값은 "ko"(값이 아직 없을 때 기존 동작과 동일).
import { shared, setShared } from "herdr";

export function lang() { return shared("board.lang") === "en" ? "en" : "ko"; }
export function setLang(l) { setShared("board.lang", l === "en" ? "en" : "ko"); }
export function tr(ko, en) { return lang() === "en" ? en : ko; }
