import type { AccountCategory, Side } from "../lib/types";

/**
 * 勘定科目マスター（初期投入用）
 * 並び順は青色申告決算書に合わせています。
 * 現時点では科目の追加はできません。使わない科目は「勘定科目」画面で非表示にします。
 */
export interface AccountSeed {
  code: string;
  name: string;
  kana: string;
  category: AccountCategory;
  normal_side: Side;
}

const a = (code: string, name: string, kana: string, category: AccountCategory, normal_side: Side): AccountSeed =>
  ({ code, name, kana, category, normal_side });

export const ACCOUNT_SEEDS: AccountSeed[] = [
  // ── 資産 ──
  a("101", "現金", "げんきん", "asset", "debit"),
  a("102", "当座預金", "とうざよきん", "asset", "debit"),
  a("103", "普通預金", "ふつうよきん", "asset", "debit"),
  a("104", "定期預金", "ていきよきん", "asset", "debit"),
  a("110", "受取手形", "うけとりてがた", "asset", "debit"),
  a("111", "売掛金", "うりかけきん", "asset", "debit"),
  a("112", "有価証券", "ゆうかしょうけん", "asset", "debit"),
  a("113", "棚卸資産", "たなおろししさん", "asset", "debit"),
  a("114", "前払金", "まえばらいきん", "asset", "debit"),
  a("115", "貸付金", "かしつけきん", "asset", "debit"),
  a("116", "未収入金", "みしゅうにゅうきん", "asset", "debit"),
  a("117", "仮払金", "かりばらいきん", "asset", "debit"),
  a("130", "建物", "たてもの", "asset", "debit"),
  a("131", "建物附属設備", "たてものふぞくせつび", "asset", "debit"),
  a("132", "機械装置", "きかいそうち", "asset", "debit"),
  a("133", "車両運搬具", "しゃりょううんぱんぐ", "asset", "debit"),
  a("134", "工具器具備品", "こうぐきぐびひん", "asset", "debit"),
  a("135", "土地", "とち", "asset", "debit"),
  a("140", "敷金", "しききん", "asset", "debit"),
  a("190", "事業主貸", "じぎょうぬしかし", "asset", "debit"),

  // ── 負債 ──
  a("201", "支払手形", "しはらいてがた", "liability", "credit"),
  a("202", "買掛金", "かいかけきん", "liability", "credit"),
  a("203", "借入金", "かりいれきん", "liability", "credit"),
  a("204", "未払金", "みばらいきん", "liability", "credit"),
  a("205", "前受金", "まえうけきん", "liability", "credit"),
  a("206", "預り金", "あずかりきん", "liability", "credit"),
  a("207", "仮受金", "かりうけきん", "liability", "credit"),

  // ── 資本 ──
  a("301", "事業主借", "じぎょうぬしかり", "equity", "credit"),
  a("302", "元入金", "もといれきん", "equity", "credit"),

  // ── 収益 ──
  a("401", "売上高", "うりあげだか", "revenue", "credit"),
  a("402", "家事消費等", "かじしょうひとう", "revenue", "credit"),
  a("403", "雑収入", "ざつしゅうにゅう", "revenue", "credit"),

  // ── 売上原価 ──
  a("501", "期首商品棚卸高", "きしゅしょうひんたなおろしだか", "cogs", "debit"),
  a("502", "仕入高", "しいれだか", "cogs", "debit"),
  a("503", "期末商品棚卸高", "きまつしょうひんたなおろしだか", "cogs", "credit"),

  // ── 経費 ──
  a("601", "租税公課", "そぜいこうか", "expense", "debit"),
  a("602", "荷造運賃", "にづくりうんちん", "expense", "debit"),
  a("603", "水道光熱費", "すいどうこうねつひ", "expense", "debit"),
  a("604", "旅費交通費", "りょひこうつうひ", "expense", "debit"),
  a("605", "通信費", "つうしんひ", "expense", "debit"),
  a("606", "広告宣伝費", "こうこくせんでんひ", "expense", "debit"),
  a("607", "接待交際費", "せったいこうさいひ", "expense", "debit"),
  a("608", "損害保険料", "そんがいほけんりょう", "expense", "debit"),
  a("609", "修繕費", "しゅうぜんひ", "expense", "debit"),
  a("610", "消耗品費", "しょうもうひんひ", "expense", "debit"),
  a("611", "減価償却費", "げんかしょうきゃくひ", "expense", "debit"),
  a("612", "福利厚生費", "ふくりこうせいひ", "expense", "debit"),
  a("613", "給料賃金", "きゅうりょうちんぎん", "expense", "debit"),
  a("614", "外注工賃", "がいちゅうこうちん", "expense", "debit"),
  a("615", "利子割引料", "りしわりびきりょう", "expense", "debit"),
  a("616", "地代家賃", "ちだいやちん", "expense", "debit"),
  a("617", "貸倒金", "かしだおれきん", "expense", "debit"),
  a("620", "支払手数料", "しはらいてすうりょう", "expense", "debit"),
  a("621", "車両費", "しゃりょうひ", "expense", "debit"),
  a("622", "新聞図書費", "しんぶんとしょひ", "expense", "debit"),
  a("623", "会議費", "かいぎひ", "expense", "debit"),
  a("624", "研修費", "けんしゅうひ", "expense", "debit"),
  a("625", "諸会費", "しょかいひ", "expense", "debit"),
  a("699", "雑費", "ざっぴ", "expense", "debit"),

  // ── 所得計算の後段 ──
  a("701", "専従者給与", "せんじゅうしゃきゅうよ", "special", "debit"),
];

/** ロジックで特別扱いする科目のコード */
export const CODE = {
  CASH: "101",
  BANK: "103",
  OWNER_DRAW: "190", // 事業主貸
  OWNER_LOAN: "301", // 事業主借
  CAPITAL: "302",    // 元入金
} as const;

/** 帳簿入力（出納帳）で選べる科目 */
export const CASHBOOK_CODES = ["101", "102", "103", "104", "111", "202", "204", "190", "301"];

export const CATEGORY_LABEL: Record<AccountCategory, string> = {
  asset: "資産",
  liability: "負債",
  equity: "資本",
  revenue: "収益",
  cogs: "売上原価",
  expense: "経費",
  special: "専従者給与等",
};

export const BS_CATEGORIES: AccountCategory[] = ["asset", "liability", "equity"];
export const PL_CATEGORIES: AccountCategory[] = ["revenue", "cogs", "expense", "special"];

export const isBalanceSheet = (c: AccountCategory) => BS_CATEGORIES.includes(c);

/** 区分ごとのコード範囲（追加する科目もこの範囲で番号を振る） */
export const CATEGORY_CODE_RANGE: Record<AccountCategory, [number, number]> = {
  asset: [100, 199],
  liability: [200, 299],
  equity: [300, 399],
  revenue: [400, 499],
  cogs: [500, 599],
  expense: [600, 699],
  special: [700, 799],
};

/** 区分から残高の側を決める（追加科目用。売上原価の控除科目のような例外は初期科目だけ） */
export const normalSideOf = (c: AccountCategory): Side =>
  c === "liability" || c === "equity" || c === "revenue" ? "credit" : "debit";

/** 仕組み上、隠したり名前を変えたりすると困る科目 */
export const LOCKED_CODES: string[] = [CODE.CASH, CODE.OWNER_DRAW, CODE.OWNER_LOAN, CODE.CAPITAL];
