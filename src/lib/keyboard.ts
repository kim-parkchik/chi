import type { KeyboardEvent } from "react";
import { flushSync } from "react-dom";

/** 日本語変換中の Enter かどうか */
export const isComposing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;

/**
 * Enter で次の入力欄へ移動する（市販の会計ソフトと同じ操作感）。
 * data-nav 属性を持つ要素を、同じ data-navgroup の中で順にたどる。
 * 最後の欄で Enter したときは onLast を呼ぶ。
 */
export const enterToNext = (onLast?: () => void) => (e: KeyboardEvent<HTMLElement>) => {
  if (e.key !== "Enter" || isComposing(e) || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  const current = e.currentTarget;
  const group = current.closest("[data-navgroup]");
  if (!group) return;
  // 先に入力を確定させて画面に反映する（科目を確定すると補助科目欄が使えるようになる、など）
  flushSync(() => current.blur());
  const items = Array.from(group.querySelectorAll<HTMLElement>("[data-nav]")).filter(
    (el) => !(el as HTMLInputElement).disabled && el.getAttribute("data-nav") !== "false",
  );
  const i = items.indexOf(current);
  if (i >= 0 && i < items.length - 1) {
    const next = items[i + 1];
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  } else {
    onLast?.();
  }
};
