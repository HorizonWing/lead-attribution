import { describe, expect, it } from "vitest";

import { pickCountry, pickIpAddress } from "../src/utils/client-info";
import { MAX_FIELD_LENGTH } from "../src/utils/lead-context";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("pickIpAddress", () => {
  it("优先级：cf-connecting-ip > x-real-ip > x-forwarded-for 首段", () => {
    expect(
      pickIpAddress(
        headers({
          "cf-connecting-ip": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
          "x-forwarded-for": "3.3.3.3",
        }),
      ),
    ).toBe("1.1.1.1");
    expect(
      pickIpAddress(headers({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })),
    ).toBe("2.2.2.2");
    expect(pickIpAddress(headers({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
  });

  it("headers 为 null：返回 undefined", () => {
    expect(pickIpAddress(null)).toBeUndefined();
  });

  it("空串头回退到下一优先级，不落库空 IP", () => {
    expect(pickIpAddress(headers({ "cf-connecting-ip": "", "x-real-ip": "2.2.2.2" }))).toBe(
      "2.2.2.2",
    );
  });

  it("伪造超长 XFF 首段（>2048）丢弃（B1）", () => {
    expect(
      pickIpAddress(headers({ "x-forwarded-for": "x".repeat(MAX_FIELD_LENGTH + 1) })),
    ).toBeUndefined();
  });

  it("全部缺失：undefined", () => {
    expect(pickIpAddress(headers({}))).toBeUndefined();
  });
});

describe("pickCountry", () => {
  it("取 cf-ipcountry", () => {
    expect(pickCountry(headers({ "cf-ipcountry": "US" }))).toBe("US");
  });

  it("缺失/空串/null headers：undefined", () => {
    expect(pickCountry(headers({}))).toBeUndefined();
    expect(pickCountry(headers({ "cf-ipcountry": "" }))).toBeUndefined();
    expect(pickCountry(null)).toBeUndefined();
  });
});
