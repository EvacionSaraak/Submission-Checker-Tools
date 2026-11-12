#!/usr/bin/env python3
"""Extract the DoH LOINC terminology vocabulary using Python stdlib only.

Reads original OOXML ZIP contents without modifying the spreadsheet. Fails closed
if the LOINC_NUM/STATUS columns cannot be identified. Run from repository root.
"""
from __future__ import annotations

import collections
import datetime
import hashlib
import json
import pathlib
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

SOURCE = pathlib.Path("resources/Codes-LOINC.xlsx")
OUTPUT = pathlib.Path("json/loinc_code_mapping.json")
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

def github_blob_sha(path: pathlib.Path) -> str:
    """Compute Git blob SHA from the current workbook bytes, not a stale constant."""
    h = hashlib.sha1()
    h.update(b"blob " + str(path.stat().st_size).encode("ascii") + b"\x00")
    with path.open("rb") as handle:
        for part in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()

def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(SOURCE)
    statuses = {}
    replacements = {}
    sheet_stats = []
    with zipfile.ZipFile(SOURCE, "r") as z:
        strings = load_shared_strings(z)
        sheets = sorted((n for n in z.namelist()
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
            key=lambda name: int(re.search(r"sheet(\d+)", name).group(1)))
        if not sheets:
            raise RuntimeError("No worksheets in the DoH LOINC workbook")
        print("Workbook sheets:", len(sheets), "Shared strings:", len(strings), flush=True)
        for name in sheets:
            columns = None
            rows_seen = 0
            mapped = 0
            first_rows = []
            for row in iter_sheet_rows(z, name, strings):
                rows_seen += 1
                if columns is None:
                    if len(first_rows) < 35:
                        first_rows.append(row)
                    by_name = {normalize_header(v): k for k,v in row.items()}
                    if "loincnum" in by_name and "status" in by_name:
                        columns = (by_name["loincnum"], by_name["status"], by_name.get("mapto"))
                        print(name, "columns:", columns, "headers:", str(row)[:1600], flush=True)
                    continue
                loinc_col, status_col, map_col = columns
                loinc = str(row.get(loinc_col, "")).strip()
                if not LOINC_PATTERN.fullmatch(loinc):
                    continue
                status = str(row.get(status_col, "")).strip().upper() or "UNKNOWN"
                statuses[loinc] = status
                if map_col is not None:
                    target = str(row.get(map_col, "")).strip()
                    if target:
                        replacements[loinc] = target
                mapped += 1
            if columns is None:
                print(name, "unrecognized; first rows:", first_rows[:3], flush=True)
            sheet_stats.append({"sheet":name,"rows":rows_seen,"loincCodes":mapped,
                "headersFound":columns is not None})
    counts = collections.Counter(statuses.values())
    if len(statuses) < 1000:
        raise RuntimeError(f"Only {len(statuses)} LOINC codes found; refusing incomplete export: {sheet_stats}")
    # LOINC_NUM is the vocabulary identifier. This workbook does NOT contain
    # CPT/Activity.Code columns, so it cannot prove activity-to-LOINC pairing.
    result = {
        "metadata": {
            "source": str(SOURCE).replace("\\", "/"),
            "sourceBlobSHA": github_blob_sha(SOURCE),
            "generatedUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "loincCount": len(statuses),
            "statusCounts": dict(sorted(counts.items())),
            "sheetStatistics": sheet_stats,
            "validationScope": "LOINC vocabulary membership and terminology status only",
            "activityCodeMappingAvailable": False,
            "note": "DoH dictionary Codes-LOINC.xlsx has LOINC_NUM, STATUS and MAP_TO but no CPT/activity-code-to-LOINC crosswalk. Do not infer parent-code compatibility from this file.",
            "valueValidationEnabled": False,
            "activeStatus": "ACTIVE",
            "nonActiveInterpretation": "DEPRECATED=Invalid; DISCOURAGED/TRIAL/other statuses=Unknown pending policy verification",
            "unknownLoincInterpretation": "Unknown (newer codes may not exist in this workbook)"
        },
        "statusByLoinc": dict(sorted(statuses.items())),
        "mapTo": dict(sorted(replacements.items()))
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n",
                      encoding="utf-8")
    print("OUTPUT:",OUTPUT,"codes:",len(statuses),"statuses:",dict(counts),
          "mapTo:",len(replacements),"bytes:",OUTPUT.stat().st_size,flush=True)

if __name__ == "__main__":
    main()
