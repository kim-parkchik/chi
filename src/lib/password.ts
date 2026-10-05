/**
 * ユーザーのパスワード（任意）
 * PBKDF2-SHA256 でハッシュにして保存する。形式：pbkdf2-sha256$繰り返し回数$ソルト(16進)$ハッシュ(16進)
 * 帳簿ファイルを直接書き換えればパスワードは外せる（ローカルのソフトの限界。README に記載）
 */
const ITERATIONS = 200_000;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));

const derive = async (password: string, salt: Uint8Array, iterations: number) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return hex(new Uint8Array(bits));
};

export const hashPassword = async (password: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${await derive(password, salt, ITERATIONS)}`;
};

/** stored が空（パスワードなし）なら常に true */
export const verifyPassword = async (password: string, stored: string) => {
  if (!stored) return true;
  const [alg, iter, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const got = await derive(password, unhex(salt), Number(iter));
  // 文字ごとに比べ終えてから判定する（途中で抜けない）
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
};

export const validatePassword = (p: string): string | null => {
  if (p.length < 4) return "パスワードは4文字以上にしてください";
  if (p.length > 100) return "パスワードは100文字までです";
  return null;
};
