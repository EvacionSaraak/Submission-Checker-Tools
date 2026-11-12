#!/usr/bin/env python3
"""Extract a DoH Codes-LOINC.xlsx code/LOINC crosswalk using Python stdlib only.

Reads original OOXML ZIP contents without modifying the spreadsheet. Fails closed
if required columns cannot be identified. Run from repository root.
"""
from __future__ import annotations

import collections
import datetime
import json
import pathlib
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

SOURCE = pathlib.Path("resources/Codes-LOINC.xlsx")
OUTPUT = pathlib.Path("json/loinc_code_mapping.json")
SOURCE_BLOB_SHA = "9509021c62f1708e81b4ba78789402066a65d13e"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
LOINC_PATTERN = re.compile(r"\b\d{1,8}-\d\b")
CELL_COL = re.compile(r"^([A-Z]+)")
SPLIT_LOINC = re.compile(r"[,;|\s]+")

def col_number(address: str) -> int:
    match = CELL_COL.match(address)
    if not match:
        return -1
    column = 0
    for letter in match.group(1):
        column = column * 26 + ord(letter) - 64
    return column - 1

def load_shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    output = []
    with z.open("xl/sharedStrings.xml") as fh:
        for _, el in ET.iterparse(fh, events=("end",)):
            if el.tag.endswith("}si"):
                output.append("".join(e.text or "" for e in el.iter()
                    if e.tag.endswith("}t")))
                el.clear()
    return output

def iter_sheet_rows(z: zipfile.ZipFile, name: str, strings: list[str]):
    with z.open(name) as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if not element.tag.endswith("}row"):
                continue
            values = {}
            for cell in element.findall("m:c", NS):
                col = col_number(cell.get("r", ""))
                if col < 0:
                    continue
                v = cell.find("m:v", NS)
                typ = cell.get("t", "")
                if typ == "s" and v is not None:
                    try:
                        val = strings[int(v.text or "0")]
                    except (IndexError, ValueError):
                        val = ""
                elif typ == "inlineStr":
                    inline = cell.find("m:is", NS)
                    val = "" if inline is None else "".join(x.text or "" for x
                        in inline.iter() if x.tag.endswith("}t"))
                elif v is not None:
                    val = v.text or ""
                else:
                    val = ""
                values[col] = val.strip() if isinstance(val, str) else str(val)
            yield values
            element.clear()

def normalize_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower().strip())

def code_score(raw: str) -> int:
    v = normalize_header(raw)
    if "loinc" in v:
        return -1
    if v in ("activitycode", "cptcode", "servicecode", "procedurecode", "testcode",
             "tariffcode", "code", "activity", "cpt", "servicecodeid"):
        return {"activitycode": 11, "cptcode": 10, "servicecode": 9,
                "procedurecode": 9, "testcode": 8, "tariffcode": 8,
                "code": 7}.get(v, 6)
    if "code" in v and any(t in v for t in ("activity", "cpt", "test", "procedure", "service", "tariff")):
        return 5
    return -1

def loinc_score(raw: str) -> int:
    v = normalize_header(raw)
    if v in ("loinc", "loinccode", "loincnumber", "loincid", "loincno"):
        return 10
    if "loinc" in v and not any(x in v for x in ("description", "name", "component", "system", "longcommon")):
        return 5
    return -1

def type_score(raw: str) -> int:
    v = normalize_header(raw)
    return 3 if v in ("activitytype", "servicetype", "codetype", "type") else -1

def detect_header(row: dict):
    code_options = sorted(((code_score(v), k) for k, v in row.items()), reverse=True)
    loinc_options = sorted(((loinc_score(v), k) for k, v in row.items()), reverse=True)
    types = sorted(((type_score(v), k) for k, v in row.items()), reverse=True)
    if not code_options or not loinc_options or code_options[0][0] < 0 or loinc_options[0][0] < 0:
        return None
    code_col = code_options[0][1]
    loinc_col = loinc_options[0][1]
    if code_col == loinc_col:
        return None
    type_col = types[0][1] if types and types[0][0] >= 0 else None
    return (code_col, loinc_col, type_col)

def normalize_code(value: str) -> str:
    return re.sub(r"\.0$", "", str(value or "").strip()).upper()

def extract_loincs(value: str) -> list[str]:
    return list(dict.fromkeys(LOINC_PATTERN.findall(str(value or ""))))

def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(SOURCE)
    mapping = collections.defaultdict(set)
    typed_mapping = collections.defaultdict(lambda: collections.defaultdict(set))
    sheet_stats = []
    unmatched_sheets = []
    with zipfile.ZipFile(SOURCE, "r") as z:
        strings = load_shared_strings(z)
        sheets = sorted((n for n in z.namelist()
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
            key=lambda s: int(re.search(r"sheet(\d+)", s).group(1)))
        if not sheets:
            raise RuntimeError("No worksheet XML found")
        print("Workbook sheets:", len(sheets), "Shared strings:", len(strings), flush=True)
        for name in sheets:
            column_map = None
            examined = []
            rows_seen = 0
            matches = 0
            types_seen = collections.Counter()
            for row in iter_sheet_rows(z, name, strings):
                rows_seen += 1
                if column_map is None:
                    if len(examined) < 35:
                        examined.append(list(row.items())[:16])
                        column_map = detect_header(row)
                    if column_map is None:
                        continue
                    print(name, "header:", str(row)[:2000], flush=True)
                    continue
                code_col, loinc_col, type_col = column_map
                code = normalize_code(row.get(code_col, ""))
                loincs = extract_loincs(row.get(loinc_col, ""))
                if not code or not loincs or LOINC_PATTERN.fullmatch(code):
                    continue
                mapping[code].update(loincs)
                matches += len(loincs)
                if type_col is not None:
                    raw_type = normalize_code(row.get(type_col, ""))
                    if raw_type:
                        types_seen[raw_type] += 1
                        typed_mapping[raw_type][code].update(loincs)
            sheet_stats.append({"sheet": name, "rows": rows_seen,
                "mappedCells": matches, "columns": column_map, "activityTypes": dict(types_seen)})
            if column_map is None:
                unmatched_sheets.append({"sheet": name, "firstRows": examined[:3]})
            print(f"{name}: {rows_seen} rows; {matches} LOINC associations; header={column_map}",
                  flush=True)
    pair_count = sum(len(v) for v in mapping.values())
    if pair_count < 50:
        raise RuntimeError(f"Only {pair_count} pairs found, refusing to create an incomplete mapping. "
            f"Sheet stats: {sheet_stats}. Unrecognized sheets: {str(unmatched_sheets)[:2500]}")
    # The conservative code-only lookup works even if the official export does not
    # carry Activity.Type. When it does, preserve that dimension too.
    data = {
        "metadata": {
            "source": str(SOURCE).replace("\\", "/"),
            "sourceBlobSHA": SOURCE_BLOB_SHA,
            "generatedUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "purpose": "Validate each XML Observation.Type=LOINC, Observation.Code against its parent Activity.Code",
            "codeCount": len(mapping),
            "uniquePairs": pair_count,
            "sheetStatistics": sheet_stats,
            "unrecognizedSheets": [s["sheet"] for s in unmatched_sheets],
            "semantics": "Presence in listed set means valid. Missing Activity.Code is unverified, not invalid. Observation value is not considered.",
            "doHCodeValidity": "Not asserted; this crosswalk does not establish tariff code activeness.",
        },
        "codes": {code: sorted(values) for code, values in sorted(mapping.items())},
    }
    if typed_mapping:
        data["activityTypes"] = {ty: {code: sorted(v) for code, v in sorted(codes.items())}
            for ty, codes in sorted(typed_mapping.items())}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8")
    print("OUTPUT:", OUTPUT, "codes:", len(mapping), "pairs:", pair_count,
          "bytes:", OUTPUT.stat().st_size, "types:", list(typed_mapping), flush=True)

if __name__ == "__main__":
    main()
