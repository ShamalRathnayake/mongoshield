import { Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  clusterTimeOfReply,
  clusterTimeOfResumeToken,
  compareClusterTimes,
  formatClusterTime,
  latestClusterTimeOfReply,
  toClusterTime,
  toTimestamp,
} from "./converge-time.ts";

describe("cluster times", () => {
  it("round-trips between { t, i } and a driver Timestamp", () => {
    const timestamp = toTimestamp({ t: 1_792_521_120, i: 23 });
    expect(timestamp).toBeInstanceOf(Timestamp);
    expect(toClusterTime(timestamp)).toEqual({ t: 1_792_521_120, i: 23 });
  });

  it("orders by seconds first, then by increment", () => {
    expect(compareClusterTimes({ t: 1, i: 9 }, { t: 2, i: 0 })).toBeLessThan(0);
    expect(compareClusterTimes({ t: 2, i: 1 }, { t: 2, i: 0 })).toBeGreaterThan(0);
    expect(compareClusterTimes({ t: 2, i: 1 }, { t: 2, i: 1 })).toBe(0);
  });

  it("formats as t:i", () => {
    expect(formatClusterTime({ t: 5, i: 7 })).toBe("5:7");
  });

  it("reads operationTime from a reply, falling back to $clusterTime", () => {
    const time = new Timestamp({ t: 10, i: 2 });
    expect(clusterTimeOfReply({ ok: 1, operationTime: time })).toEqual({ t: 10, i: 2 });
    expect(clusterTimeOfReply({ ok: 1, $clusterTime: { clusterTime: time } })).toEqual({
      t: 10,
      i: 2,
    });
    expect(clusterTimeOfReply({ ok: 1 })).toBeUndefined();
  });
});

describe("clusterTimeOfResumeToken", () => {
  it("decodes the cluster time at the start of a resume token", () => {
    // A real high-water-mark token from MongoDB 7.0: 0x82, then t=0x6AD7B3A0, i=0x17.
    expect(clusterTimeOfResumeToken({ _data: "826AD7B3A0000000172B0429296E1404" })).toEqual({
      t: 0x6ad7b3a0,
      i: 0x17,
    });
  });

  it("returns undefined for anything else", () => {
    expect(clusterTimeOfResumeToken(undefined)).toBeUndefined();
    expect(clusterTimeOfResumeToken({ _data: "82AB" })).toBeUndefined();
    expect(clusterTimeOfResumeToken({ _data: "136AD7B3A000000017" })).toBeUndefined();
    expect(clusterTimeOfResumeToken({ _data: "82zzzzzzzzzzzzzzzz" })).toBeUndefined();
  });
});

describe("latestClusterTimeOfReply", () => {
  it("prefers the logical clock when operationTime lags behind it", () => {
    // Seen on MongoDB 8.0 under load: operationTime behind writes already applied.
    const reply = {
      ok: 1,
      operationTime: new Timestamp({ t: 10, i: 2 }),
      $clusterTime: { clusterTime: new Timestamp({ t: 10, i: 9 }) },
    };
    expect(latestClusterTimeOfReply(reply)).toEqual({ t: 10, i: 9 });
    // The early reader keeps using operationTime.
    expect(clusterTimeOfReply(reply)).toEqual({ t: 10, i: 2 });
  });

  it("uses whichever time is present, and the later of the two", () => {
    const time = new Timestamp({ t: 11, i: 1 });
    expect(latestClusterTimeOfReply({ ok: 1, operationTime: time })).toEqual({ t: 11, i: 1 });
    expect(latestClusterTimeOfReply({ ok: 1, $clusterTime: { clusterTime: time } })).toEqual({
      t: 11,
      i: 1,
    });
    expect(
      latestClusterTimeOfReply({
        ok: 1,
        operationTime: new Timestamp({ t: 12, i: 0 }),
        $clusterTime: { clusterTime: time },
      }),
    ).toEqual({ t: 12, i: 0 });
    expect(latestClusterTimeOfReply({ ok: 1 })).toBeUndefined();
  });
});
