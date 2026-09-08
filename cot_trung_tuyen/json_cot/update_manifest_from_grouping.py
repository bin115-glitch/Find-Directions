#!/usr/bin/env python3
"""Update cot_trung_tuyen/json_cot/manifest.json by injecting 'xa' lists from grouping_manifest.json

Usage:
  python cot_trung_tuyen/json_cot/update_manifest_from_grouping.py [--apply]

Without --apply the script prints planned changes (dry-run). With --apply it writes a backup and updates manifest.json.
"""
from pathlib import Path
import json
import argparse

ROOT = Path(__file__).resolve().parent
GROUPING = ROOT / 'grouping_manifest.json'
MANIFEST = ROOT / 'manifest.json'


def load_json(p):
    with p.open('r', encoding='utf-8') as f:
        return json.load(f)


def main(apply=False):
    if not GROUPING.exists():
        raise SystemExit(f"Missing {GROUPING}")
    if not MANIFEST.exists():
        raise SystemExit(f"Missing {MANIFEST}")

    grouping = load_json(GROUPING)
    manifest = load_json(MANIFEST)

    # build map: code -> list of district names
    code_to_districts = {}
    for code, mapping in grouping.items():
        if isinstance(mapping, dict):
            code_to_districts[code] = list(mapping.keys())

    planned = []
    for entry in manifest:
        key = entry.get('key')
        if not key:
            continue
        districts = code_to_districts.get(key)
        if districts:
            # normalize district names (keep as-is)
            old = entry.get('xa')
            planned.append((key, old, districts))

    if not planned:
        print('No updates found (no matching codes in grouping_manifest.json).')
        return

    print('Planned updates:')
    for key, old, districts in planned:
        print(f"- {key}: {len(districts)} districts")

    if not apply:
        print('\nDry-run; re-run with --apply to write manifest.json')
        return

    # backup
    bak = MANIFEST.with_suffix('.json.bak')
    MANIFEST.replace(bak)
    print(f'Backup written to: {bak}')

    # reload backup and write updates
    manifest_data = load_json(bak)
    for entry in manifest_data:
        k = entry.get('key')
        if k in code_to_districts:
            entry['xa'] = code_to_districts[k]

    with MANIFEST.open('w', encoding='utf-8') as f:
        json.dump(manifest_data, f, ensure_ascii=False, indent=2)
    print(f'Wrote updated manifest: {MANIFEST}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Update manifest.json from grouping_manifest.json')
    ap.add_argument('--apply', action='store_true', help='actually write manifest.json')
    args = ap.parse_args()
    main(apply=args.apply)
