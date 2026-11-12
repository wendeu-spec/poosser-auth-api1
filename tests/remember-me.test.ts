import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

/**
 * « Rester connecté sur cet appareil » : refresh token dans un cookie
 * HttpOnly / SameSite=Strict / Path=/auth (voir src/lib/refreshCookie.ts),
 * jamais dans le corps des réponses, avec la même rotation et la même
 * détection de réutilisation qu'un refresh token classique.
 */

beforeEach(resetDb);

function refreshCookieOf(res: request.Response): string | null {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const line = (raw ?? []).find((c) => c.startsWith("poosser_rt="));
  return line ?? null;
}
const cookiePair = (setCookieLine: string) => setCookieLine.split(";")[0]!; // "poosser_rt=..."

async function loginRemembered() {
  const { phone, pin, device } = await registerFreshUser();
  const res = await request(app).post("/auth/login").send({ phone, pin, device, rememberMe: true }).expect(200);
  return { res, phone, pin, device };
}

describe("Connexion automatique (cookie « rester connecté »)", () => {
  it("rememberMe pose un cookie HttpOnly, SameSite=Strict, limité à /auth, et ne renvoie pas le refresh token", async () => {
    const { res } = await loginRemembered();
    const cookie = refreshCookieOf(res);
    expect(cookie).not.toBeNull();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.rememberMe).toBe(true);
  });

  it("sans rememberMe, comportement inchangé : aucun cookie, refresh token dans le corps", async () => {
    const { phone, pin, device } = await registerFreshUser();
    const res = await request(app).post("/auth/login").send({ phone, pin, device }).expect(200);
    expect(refreshCookieOf(res)).toBeNull();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("le cookie seul suffit à rouvrir une session (connexion automatique), et tourne à chaque fois", async () => {
    const { res } = await loginRemembered();
    const first = cookiePair(refreshCookieOf(res)!);

    const refreshed = await request(app).post("/auth/refresh").set("Cookie", first).send({}).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body.refreshToken).toBeUndefined();
    const second = refreshCookieOf(refreshed);
    expect(second).not.toBeNull();
    expect(cookiePair(second!)).not.toBe(first);

    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${refreshed.body.accessToken}`).expect(200);
    expect(me.body.phone ?? me.body.phoneE164 ?? me.body.id).toBeTruthy();
  });

  it("rejouer un ancien cookie déclenche la détection de réutilisation et efface le cookie", async () => {
    const { res } = await loginRemembered();
    const first = cookiePair(refreshCookieOf(res)!);
    const refreshed = await request(app).post("/auth/refresh").set("Cookie", first).send({}).expect(200);
    const second = cookiePair(refreshCookieOf(refreshed)!);

    const replay = await request(app).post("/auth/refresh").set("Cookie", first).send({}).expect(401);
    expect(replay.body.error.code).toBe("REFRESH_REUSE_DETECTED");
    expect(refreshCookieOf(replay)).toMatch(/poosser_rt=;/);

    // Toute la famille est révoquée : le cookie légitime le plus récent ne marche plus non plus.
    await request(app).post("/auth/refresh").set("Cookie", second).send({}).expect(401);
  });

  it("sans cookie ni refresh token dans le corps, le rafraîchissement est refusé", async () => {
    const res = await request(app).post("/auth/refresh").send({}).expect(401);
    expect(res.body.error.code).toBe("REFRESH_INVALID");
  });

  it("la déconnexion révoque la session du cookie et efface le cookie", async () => {
    const { res } = await loginRemembered();
    const cookie = cookiePair(refreshCookieOf(res)!);

    const out = await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .set("Cookie", cookie)
      .send({})
      .expect(204);
    expect(refreshCookieOf(out)).toMatch(/poosser_rt=;/);

    await request(app).post("/auth/refresh").set("Cookie", cookie).send({}).expect(401);
  });

  it("un usage normal de l'API n'épuise pas la limite de /auth : la reconnexion reste possible", async () => {
    // Régression : /auth et /api partageaient le même compteur anti-abus par IP.
    const { res } = await loginRemembered();
    const cookie = cookiePair(refreshCookieOf(res)!);
    for (let i = 0; i < 70; i++) {
      await request(app).get("/api/accounts").set("Authorization", `Bearer ${res.body.accessToken}`).expect(200);
    }
    await request(app).post("/auth/refresh").set("Cookie", cookie).send({}).expect(200);
  });

  it("le cookie d'un utilisateur n'ouvre que la session de cet utilisateur", async () => {
    const alice = await loginRemembered();
    const bob = await loginRemembered();
    const aliceCookie = cookiePair(refreshCookieOf(alice.res)!);

    const refreshed = await request(app).post("/auth/refresh").set("Cookie", aliceCookie).send({}).expect(200);
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${refreshed.body.accessToken}`).expect(200);
    expect(me.body.id).toBe(alice.res.body.user.id);
    expect(me.body.id).not.toBe(bob.res.body.user.id);
  });
});
