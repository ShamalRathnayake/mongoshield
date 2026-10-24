import fc from "fast-check";
import { Binary, BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHIFT_DAYS, FAKE_KINDS, fakeValue } from "./fake.ts";
import { UNSUPPORTED } from "./hash.ts";
import { deriveMaskKeys } from "./keyed.ts";

const keys = deriveMaskKeys("a test secret that is long enough");
const otherKeys = deriveMaskKeys("another secret, also long enough");

/** A sample input that each kind accepts. */
const SAMPLE_INPUT = {
  email: "ada@lovelace.org",
  name: "Ada Lovelace",
  phone: "+44 20 7946 0958",
  address: "12 Real Street, London",
  ip: "192.168.1.20",
  uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "date-shift": new Date("2026-01-15T10:30:00Z"),
} as const;

describe("fakeValue", () => {
  it.each(FAKE_KINDS)("is deterministic for %s", (kind) => {
    const input = SAMPLE_INPUT[kind];
    expect(fakeValue(input, kind, keys)).toEqual(fakeValue(input, kind, keys));
    expect(fakeValue(input, kind, keys)).not.toEqual(input);
  });

  it("is deterministic and secret-dependent for any email", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(fakeValue(email, "email", keys)).toBe(fakeValue(email, "email", keys));
        expect(fakeValue(email, "email", keys)).not.toBe(fakeValue(email, "email", otherKeys));
      }),
    );
  });

  it("makes emails that can only go to reserved example domains", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(String(fakeValue(email, "email", keys))).toMatch(
          /^[a-z]+\.[a-z]+\.[a-z2-7]{8}@example\.(com|net|org)$/,
        );
      }),
    );
  });

  it("makes distinct emails for distinct inputs (unique indexes keep working)", () => {
    const fakes = new Set<unknown>();
    for (let index = 0; index < 5000; index += 1) {
      fakes.add(fakeValue(`user${index}@corp.com`, "email", keys));
    }
    expect(fakes.size).toBe(5000);
  });

  it("makes plausible names and addresses", () => {
    expect(String(fakeValue("Ada Lovelace", "name", keys))).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(String(fakeValue("12 Real Street", "address", keys))).toMatch(
      /^\d{1,4} [A-Z][a-z]+ [A-Z][a-z]+, [A-Z][a-z]+$/,
    );
  });

  it("keeps the shape of phone numbers", () => {
    const fake = String(fakeValue("+44 20 7946 0958", "phone", keys));
    expect(fake).toMatch(/^\+\d\d \d\d \d{4} \d{4}$/);
  });

  it("makes private IPv4 and documentation IPv6 addresses", () => {
    expect(String(fakeValue("8.8.8.8", "ip", keys))).toMatch(/^10\.\d+\.\d+\.\d+$/);
    expect(String(fakeValue("2a00:1450::1", "ip", keys))).toMatch(/^2001:db8:/);
  });

  it("makes UUIDs of the same form as the input", () => {
    expect(String(fakeValue(SAMPLE_INPUT.uuid, "uuid", keys))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(String(fakeValue(SAMPLE_INPUT.uuid.toUpperCase(), "uuid", keys))).toMatch(
      /^[0-9A-F-]+$/,
    );
    const binary = new Binary(Buffer.from(new BSON.UUID().buffer), 4);
    const fake = fakeValue(binary, "uuid", keys);
    expect(fake instanceof Binary && fake.sub_type).toBe(4);
  });

  it("shifts dates by whole days within the limit, never by zero", () => {
    fc.assert(
      fc.property(
        fc.date({ noInvalidDate: true, min: new Date("1900-01-01"), max: new Date("2200-01-01") }),
        fc.integer({ min: 1, max: 365 }),
        (date, days) => {
          const shifted = fakeValue(date, "date-shift", keys, { days });
          expect(shifted).toBeInstanceOf(Date);
          const difference = shifted instanceof Date ? shifted.getTime() - date.getTime() : 0;
          const differenceDays = Math.abs(difference) / 86_400_000;
          expect(Number.isInteger(differenceDays)).toBe(true);
          expect(differenceDays).toBeGreaterThanOrEqual(1);
          expect(differenceDays).toBeLessThanOrEqual(days);
        },
      ),
    );
    expect(DEFAULT_SHIFT_DAYS).toBe(30);
  });

  it.each([
    ["email", 5],
    ["name", true],
    ["date-shift", "2026-01-01"],
    ["uuid", 12],
    ["phone", { number: "1" }],
  ] as const)("reports fake %s of %j as unsupported", (kind, value) => {
    expect(fakeValue(value, kind, keys)).toBe(UNSUPPORTED);
  });
});
