import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/tools/task.js";

describe("parseCsv", () => {
  it("parses a simple CSV with header and data rows", () => {
    const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    expect(parseCsv(csv)).toEqual([
      ["name", "age", "city"],
      ["Alice", "30", "NYC"],
      ["Bob", "25", "LA"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = 'name,address\nAlice,"123 Main St, Apt 4"';
    expect(parseCsv(csv)).toEqual([
      ["name", "address"],
      ["Alice", "123 Main St, Apt 4"],
    ]);
  });

  it("handles escaped quotes (\"\") inside quoted fields", () => {
    const csv = 'name,quote\nAlice,"She said ""hello"""';
    expect(parseCsv(csv)).toEqual([
      ["name", "quote"],
      ["Alice", 'She said "hello"'],
    ]);
  });

  it("handles CRLF line endings", () => {
    const csv = "a,b\r\n1,2\r\n3,4";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles LF line endings", () => {
    const csv = "a,b\n1,2\n3,4";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles empty fields", () => {
    const csv = "a,b,c\n,2,\n1,,";
    expect(parseCsv(csv)).toEqual([
      ["a", "b", "c"],
      ["", "2", ""],
      ["1", "", ""],
    ]);
  });

  it("parses a single-column CSV", () => {
    const csv = "name\nAlice\nBob";
    expect(parseCsv(csv)).toEqual([["name"], ["Alice"], ["Bob"]]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("handles a CSV with only a header row and no data", () => {
    expect(parseCsv("name,age,city")).toEqual([["name", "age", "city"]]);
    expect(parseCsv("name,age,city\n")).toEqual([["name", "age", "city"]]);
  });

  it("preserves fields with spaces", () => {
    const csv = "name,greeting\nAlice, hello world ";
    expect(parseCsv(csv)).toEqual([
      ["name", "greeting"],
      ["Alice", " hello world "],
    ]);
  });

  it("handles mixed quoted and unquoted fields in the same row", () => {
    const csv = 'name,note,age\nAlice,"likes, commas",30';
    expect(parseCsv(csv)).toEqual([
      ["name", "note", "age"],
      ["Alice", "likes, commas", "30"],
    ]);
  });

  it("ignores a trailing newline at the end of input", () => {
    const csv = "a,b\n1,2\n";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
