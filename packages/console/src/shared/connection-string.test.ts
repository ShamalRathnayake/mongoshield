/**
 * Tests for the paste helpers: what people actually paste (Atlas strings with
 * placeholders, mongosh commands, quotes, wrapped lines, raw passwords with special
 * characters) becomes a working URI, and the password is never shown.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeConnectionString,
  ConnectionStringError,
  cleanPastedConnectionString,
  encodeCredentials,
  maskConnectionString,
  separatePassword,
  withPassword,
} from "./connection-string.ts";

const ATLAS =
  "mongodb+srv://shamal:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

describe("cleanPastedConnectionString", () => {
  it("trims whitespace and removes quotes around the string", () => {
    expect(cleanPastedConnectionString('  "mongodb://localhost:27017"\n')).toBe(
      "mongodb://localhost:27017",
    );
    expect(cleanPastedConnectionString("'mongodb://a:27017'")).toBe("mongodb://a:27017");
    expect(cleanPastedConnectionString("`mongodb://a:27017`")).toBe("mongodb://a:27017");
  });

  it("joins a string that was wrapped over several lines", () => {
    expect(
      cleanPastedConnectionString(
        "mongodb+srv://u:p@cluster0.abcde.mongodb.net/?retryWrites=true\n   &w=majority\r\n&appName=x",
      ),
    ).toBe("mongodb+srv://u:p@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=x");
  });

  it("unwraps a mongosh command and keeps its --username, asking for the password", () => {
    const cleaned = cleanPastedConnectionString(
      'mongosh "mongodb+srv://cluster0.abcde.mongodb.net/" --apiVersion 1 --username shamal',
    );
    expect(cleaned).toBe("mongodb+srv://shamal:<password>@cluster0.abcde.mongodb.net/");
    expect(analyzeConnectionString(cleaned).passwordPlaceholder).toBe("<password>");
  });

  it("unwraps a mongosh command without a user name, or with single quotes", () => {
    expect(cleanPastedConnectionString("mongosh 'mongodb://db.example.com:27017/app'")).toBe(
      "mongodb://db.example.com:27017/app",
    );
    expect(cleanPastedConnectionString("mongosh mongodb://h:1 -u admin")).toBe(
      "mongodb://admin:<password>@h:1",
    );
  });

  it("does not add a user name to a string that already has one", () => {
    expect(cleanPastedConnectionString('mongosh "mongodb://me:pw@h:1" --username other')).toBe(
      "mongodb://me:pw@h:1",
    );
  });

  it("leaves text without a connection string in a mongosh command as it was", () => {
    expect(cleanPastedConnectionString("mongosh --nodb")).toBe("mongosh --nodb");
  });
});

describe("analyzeConnectionString", () => {
  it("recognises an Atlas string with a password placeholder", () => {
    const info = analyzeConnectionString(ATLAS);
    expect(info).toMatchObject({
      scheme: "mongodb+srv",
      username: "shamal",
      hasPassword: false,
      passwordPlaceholder: "<db_password>",
      hosts: ["cluster0.abcde.mongodb.net"],
      atlas: true,
      local: false,
      suggestedName: "cluster0",
      production: { suggested: true },
    });
    expect(info.production.reason).toMatch(/Atlas/);
  });

  it("treats local and Docker hosts as test databases", () => {
    for (const uri of [
      "mongodb://localhost:27017",
      "mongodb://127.0.0.1:27017/?directConnection=true",
      "mongodb://[::1]:27017",
      "mongodb://mongo:27017/?replicaSet=rs0",
      "mongodb://host.docker.internal:27017",
      "mongodb://db.local:27017",
    ]) {
      const info = analyzeConnectionString(uri);
      expect(info.local, uri).toBe(true);
      expect(info.production.suggested, uri).toBe(false);
    }
  });

  it("treats other servers as production to be safe", () => {
    const info = analyzeConnectionString(
      "mongodb://db1.example.com:27017,db2.example.com:27017/?replicaSet=prod",
    );
    expect(info.production.suggested).toBe(true);
    expect(info.production.reason).toMatch(/another server/);
    expect(info.replicaSet).toBe("prod");
  });

  it("suggests a name from the host, the replica set or the Atlas cluster", () => {
    expect(analyzeConnectionString("mongodb://mongo:27017").suggestedName).toBe("mongo");
    expect(
      analyzeConnectionString("mongodb://db1.example.com,db2.example.com/?replicaSet=shop")
        .suggestedName,
    ).toBe("shop");
    expect(analyzeConnectionString("mongodb://10.0.0.5:27017/?replicaSet=rs1").suggestedName).toBe(
      "rs1",
    );
    expect(analyzeConnectionString("mongodb://10.0.0.5:27017").suggestedName).toBe("10.0.0.5");
    expect(analyzeConnectionString("mongodb://host.docker.internal").suggestedName).toBe(
      "MongoDB on this computer",
    );
  });

  it("finds the password after the last @ even when the password contains @ / ? #", () => {
    const info = analyzeConnectionString("mongodb://app:p@ss/w?rd#1@db.example.com:27017/admin");
    expect(info.username).toBe("app");
    expect(info.hasPassword).toBe(true);
    expect(info.hosts).toEqual(["db.example.com"]);
    expect(info.credentialsNeedEncoding).toBe(true);
  });

  it("does not flag properly encoded credentials", () => {
    const info = analyzeConnectionString("mongodb://app:p%40ss%2Fw@db.example.com/");
    expect(info.credentialsNeedEncoding).toBe(false);
    expect(info.hasPassword).toBe(true);
  });

  it("flags a lone percent sign and spaces in a password", () => {
    expect(analyzeConnectionString("mongodb://u:50%off@h/").credentialsNeedEncoding).toBe(true);
    expect(analyzeConnectionString("mongodb://u:two words@h/").credentialsNeedEncoding).toBe(true);
  });

  it("reports a user name placeholder", () => {
    const info = analyzeConnectionString("mongodb+srv://<username>:<password>@c.x.mongodb.net/");
    expect(info.usernamePlaceholder).toBe("<username>");
    expect(info.passwordPlaceholder).toBe("<password>");
  });

  it("refuses text that is not a connection string", () => {
    expect(() => analyzeConnectionString("https://example.com")).toThrow(ConnectionStringError);
    expect(() => analyzeConnectionString("mongodb://")).toThrow(/no host/);
    expect(() => analyzeConnectionString(`mongodb://h/${"x".repeat(5000)}`)).toThrow(/longer/);
  });

  it("works without credentials", () => {
    const info = analyzeConnectionString("mongodb://h:27017");
    expect(info.username).toBeUndefined();
    expect(info.hasPassword).toBe(false);
  });
});

describe("withPassword", () => {
  it("replaces the placeholder with the percent-encoded password", () => {
    const uri = withPassword(ATLAS, "p@ss:w/rd?#[]%");
    expect(uri).toBe(
      "mongodb+srv://shamal:p%40ss%3Aw%2Frd%3F%23%5B%5D%25@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0",
    );
    expect(analyzeConnectionString(uri)).toMatchObject({
      hasPassword: true,
      credentialsNeedEncoding: false,
    });
  });

  it("adds a password after a bare user name", () => {
    expect(withPassword("mongodb://app@h:27017/db", "secret")).toBe(
      "mongodb://app:secret@h:27017/db",
    );
  });

  it("needs a user name", () => {
    expect(() => withPassword("mongodb://h:27017", "x")).toThrow(/no user name/);
  });
});

describe("encodeCredentials", () => {
  it("encodes a raw password and leaves everything else alone", () => {
    const result = encodeCredentials("mongodb://app:p@ss:w/rd@db.example.com:27017/admin?tls=true");
    expect(result).toEqual({
      uri: "mongodb://app:p%40ss%3Aw%2Frd@db.example.com:27017/admin?tls=true",
      changed: true,
    });
  });

  it("encodes a raw user name too", () => {
    expect(encodeCredentials("mongodb://us er:pw@h/").uri).toBe("mongodb://us%20er:pw@h/");
  });

  it("changes nothing that is already fine", () => {
    for (const uri of ["mongodb://app:p%40ss@h/", "mongodb://h/", ATLAS, "mongodb://u:a%20b@h/"]) {
      expect(encodeCredentials(uri), uri).toEqual({ uri, changed: false });
    }
  });

  it("encodes a lone percent sign but keeps valid escapes", () => {
    expect(encodeCredentials("mongodb://u:50%off%21@h/").uri).toBe("mongodb://u:50%25off%21@h/");
  });
});

describe("maskConnectionString", () => {
  it("never shows the password, raw or encoded", () => {
    expect(maskConnectionString("mongodb://app:p@ss/w@db.example.com/")).toBe(
      "mongodb://app:***@db.example.com/",
    );
    expect(maskConnectionString(ATLAS)).toBe(ATLAS);
    expect(maskConnectionString("mongodb://h/")).toBe("mongodb://h/");
    expect(maskConnectionString("not a uri")).toBe("mongodb://***");
  });
});

describe("separatePassword", () => {
  it("takes an encoded password out and gives it back decoded", () => {
    const separated = separatePassword("mongodb://app:p%40ss%2Fw@db.example.com:27017/admin");
    expect(separated).toEqual({
      uri: "mongodb://app:<password>@db.example.com:27017/admin",
      password: "p@ss/w",
    });
    // Putting it back encodes it again: the round trip is exact.
    expect(withPassword(separated.uri, separated.password ?? "")).toBe(
      "mongodb://app:p%40ss%2Fw@db.example.com:27017/admin",
    );
  });

  it("keeps a raw password as it was typed", () => {
    expect(separatePassword("mongodb://app:50%off@h/").password).toBe("50%off");
    expect(separatePassword("mongodb://app:p@ss@h/").password).toBe("p@ss");
  });

  it("leaves strings without a real password alone", () => {
    for (const uri of ["mongodb://h/", "mongodb://app@h/", ATLAS, "not a uri"]) {
      expect(separatePassword(uri), uri).toEqual({ uri });
    }
  });
});
