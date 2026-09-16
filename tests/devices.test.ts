import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, resetDb, registerFreshUser } from "./helpers.js";

beforeEach(resetDb);

describe("Gestion des appareils (/auth/devices)", () => {
  it("liste les appareils de l'utilisateur, avec le courant marqué isCurrent", async () => {
    const { body } = await registerFreshUser();
    const res = await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].isCurrent).toBe(true);
    expect(res.body.devices[0].isPrimary).toBe(true);
  });

  it("révoque un appareil précis : sa session meurt immédiatement", async () => {
    const { phone, pin, body } = await registerFreshUser();
    const login2 = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "device-2", name: "Device 2", platform: "android" } })
      .expect(200);
    const devices = await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    const device2Id = devices.body.devices.find((d: any) => d.name === "Device 2").id;

    await request(app)
      .delete(`/auth/devices/${device2Id}`)
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(204);

    await request(app).get("/auth/devices").set("Authorization", `Bearer ${login2.body.accessToken}`).expect(401);
    await request(app).post("/auth/refresh").send({ refreshToken: login2.body.refreshToken }).expect(401);

    const after = await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);
    expect(after.body.devices.find((d: any) => d.id === device2Id).status).toBe("revoked");
  });

  it("refuse de révoquer un appareil appartenant à un autre utilisateur", async () => {
    const userA = await registerFreshUser();
    const userB = await registerFreshUser();
    const devicesB = await request(app)
      .get("/auth/devices")
      .set("Authorization", `Bearer ${userB.body.accessToken}`)
      .expect(200);
    const deviceBId = devicesB.body.devices[0].id;

    const res = await request(app)
      .delete(`/auth/devices/${deviceBId}`)
      .set("Authorization", `Bearer ${userA.body.accessToken}`)
      .expect(404);
    expect(res.body.error.code).toBe("DEVICE_NOT_FOUND");
  });

  it("revoke-others révoque tous les appareils SAUF le courant", async () => {
    const { phone, pin, body } = await registerFreshUser();
    const login2 = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "device-2", name: "Device 2", platform: "android" } })
      .expect(200);
    const login3 = await request(app)
      .post("/auth/login")
      .send({ phone, pin, device: { fingerprint: "device-3", name: "Device 3", platform: "ios" } })
      .expect(200);

    await request(app)
      .post("/auth/devices/revoke-others")
      .set("Authorization", `Bearer ${body.accessToken}`)
      .expect(200);

    // Le device courant (celui de l'inscription) reste valide...
    await request(app).get("/auth/devices").set("Authorization", `Bearer ${body.accessToken}`).expect(200);
    // ...mais les deux autres sont morts.
    await request(app).get("/auth/devices").set("Authorization", `Bearer ${login2.body.accessToken}`).expect(401);
    await request(app).get("/auth/devices").set("Authorization", `Bearer ${login3.body.accessToken}`).expect(401);
  });
});
