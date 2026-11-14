// The TypeScript coordinate parser and slug must agree with the Python ones, or a name
// typed in DEMO mode and the same name resolved by the API would address different
// bundles. Python side: tests/test_sky_resolver.py and tests/test_sky_api.py.
import { describe, expect, it } from "vitest";
import { formatDec, formatRa, mjdLabel, parseCoords, skySlug } from "./sky";

const WISE = { ra: 133.795129, dec: -7.245147 };

describe("parseCoords: sexagesimal", () => {
  // Every spelling of the position the challenge brief gives for WISE 0855.
  const spellings = [
    "08 55 10.831 -07 14 42.53",
    "08h55m10.831s -07d14m42.53s",
    "08:55:10.831 -07:14:42.53",
    "08 55 10.831, -07 14 42.53",
  ];
  for (const s of spellings) {
    it(`parses ${s}`, () => {
      const c = parseCoords(s)!;
      expect(c.ra).toBeCloseTo(WISE.ra, 4);
      expect(c.dec).toBeCloseTo(WISE.dec, 4);
    });
  }

  it("keeps a negative sign on a zero degrees field", () => {
    // parseFloat("-00") is 0, so the sign has to be read from the text.
    expect(parseCoords("12 00 00 -00 30 00")!.dec).toBeCloseTo(-0.5, 6);
    expect(parseCoords("12 00 00 +00 30 00")!.dec).toBeCloseTo(+0.5, 6);
  });

  it("parses a northern target", () => {
    const c = parseCoords("16 32 40.227 +66 45 17.93")!;   // R Draconis
    expect(c.ra).toBeCloseTo(248.16761, 4);
    expect(c.dec).toBeCloseTo(66.75498, 4);
  });
});

describe("parseCoords: decimal", () => {
  it("parses space and comma separated pairs", () => {
    expect(parseCoords("133.795129 -7.245147")).toEqual({ ra: 133.795129, dec: -7.245147 });
    expect(parseCoords("133.795129, -7.245147")).toEqual({ ra: 133.795129, dec: -7.245147 });
    expect(parseCoords("  269.45208   +4.69336 ")).toEqual({ ra: 269.45208, dec: 4.69336 });
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCoords("400 -7.2")).toThrow(/out of range/);
    expect(() => parseCoords("10 -91")).toThrow(/out of range/);
  });
});

describe("parseCoords: non-coordinates", () => {
  for (const s of ["Barnard's Star", "R Dra", "WISE 0855", "", "   "]) {
    it(`returns null for ${JSON.stringify(s)}`, () => expect(parseCoords(s)).toBeNull());
  }
});

describe("skySlug", () => {
  // Must match SkyRequest.slug in pipeline/deepfield/sky/service.py exactly.
  it("matches the Python format", () => {
    expect(skySlug(133.795129, -7.245147, 0.1)).toBe("ra133.7951-dec-7.2451-fov0.100");
    expect(skySlug(269.45207696, 4.69336497, 0.1)).toBe("ra269.4521-dec+4.6934-fov0.100");
  });

  it("gives a name and its coordinates the same identity", () => {
    expect(skySlug(WISE.ra, WISE.dec, 0.1)).toBe(skySlug(parseCoords("08 55 10.831 -07 14 42.53")!.ra,
                                                          parseCoords("08 55 10.831 -07 14 42.53")!.dec, 0.1));
  });

  it("separates fields of view and the sign of Dec", () => {
    expect(skySlug(10, 20, 0.1)).not.toBe(skySlug(10, 20, 0.2));
    expect(skySlug(10, 20, 0.1)).not.toBe(skySlug(10, -20, 0.1));
  });
});

describe("display helpers", () => {
  it("formats RA and Dec back to sexagesimal", () => {
    expect(formatRa(WISE.ra)).toBe("08h 55m 10.83s");
    expect(formatDec(WISE.dec)).toBe("-07d 14m 42.5s");
  });

  it("converts MJD to a calendar date", () => {
    expect(mjdLabel(60800.70069465)).toBe("2025-05-05");   // first SPHEREx visit to WISE 0855
    expect(mjdLabel(51544.0)).toBe("2000-01-01");          // J2000
    expect(mjdLabel(40587.0)).toBe("1970-01-01");          // the Unix epoch, the offset itself
  });
});
