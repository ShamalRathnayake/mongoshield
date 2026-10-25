import { describe, expect, it } from "vitest";
import { isLocalMongoUri } from "./local-target.ts";

describe("isLocalMongoUri", () => {
  it.each([
    "mongodb://localhost:27017",
    "mongodb://localhost",
    "mongodb://127.0.0.1:27017/app?replicaSet=rs0",
    "mongodb://user:p%40ss@localhost:27017/app",
    "mongodb://[::1]:27017",
    "mongodb://localhost:27017,127.0.0.1:27018,127.0.0.2:27019/?replicaSet=rs",
    "mongodb://mongo.localhost:27017",
    "mongodb://%2Ftmp%2Fmongodb-27017.sock",
    "MONGODB://LOCALHOST",
  ])("treats %s as local", (uri) => {
    expect(isLocalMongoUri(uri)).toBe(true);
  });

  it.each([
    "mongodb+srv://cluster0.example.mongodb.net",
    "mongodb+srv://localhost",
    "mongodb://db.internal:27017",
    "mongodb://localhost:27017,db.prod:27017",
    "mongodb://10.0.0.5:27017",
    "mongodb://user:pass@localhost.evil.com:27017",
    "postgres://localhost",
    "",
    "not a uri",
  ])("treats %s as remote", (uri) => {
    expect(isLocalMongoUri(uri)).toBe(false);
  });
});
