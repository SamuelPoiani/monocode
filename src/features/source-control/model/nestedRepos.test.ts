import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNestedChangesRepo,
  loadNestedChangesRepo,
  rebaseNestedChangesRepo,
  saveNestedChangesRepo,
} from "./nestedRepos";

beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  });
});

describe("nested Changes repository", () => {
  it("remembers each plain folder's repository across path spelling changes", () => {
    saveNestedChangesRepo("/work/apps/", "api");
    saveNestedChangesRepo("C:\\Work\\Mono", "group/web");

    expect(loadNestedChangesRepo("/work/apps")).toBe("api");
    expect(loadNestedChangesRepo("c:/work/mono/")).toBe("group/web");
    expect(loadNestedChangesRepo("/work/other")).toBeUndefined();
  });

  it("follows a moved project and forgets a removed one", () => {
    saveNestedChangesRepo("/work/apps", "api");
    rebaseNestedChangesRepo("/work/apps", "/work/renamed");

    expect(loadNestedChangesRepo("/work/apps")).toBeUndefined();
    expect(loadNestedChangesRepo("/work/renamed")).toBe("api");

    clearNestedChangesRepo("/work/renamed");
    expect(loadNestedChangesRepo("/work/renamed")).toBeUndefined();
  });

  it("ignores malformed storage", () => {
    localStorage.setItem("monocode.nestedChangesRepo.v1", "[1]");
    expect(loadNestedChangesRepo("/work/apps")).toBeUndefined();
  });
});
