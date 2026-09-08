#!/usr/bin/env python3
"""Generate index.json files for each region under cot_trung_tuyen/json_cot.

It scans each region directory, groups files by district folder (if present) or by filename prefix,
and writes an `index.json` file in the region directory with structure:

{
  "region": "BGG",
  "districts": {
     "BắcGiang": [ {"name":"BắcGiang_BắcGiang_Cột_Điện.json", "url":"../cot_trung_tuyen/json_cot/BGG/BắcGiang/BắcGiang_BắcGiang_Cột_Điện.json"}, ... ]
  }
}

Usage:
  python generate_index_json.py
"""
from pathlib import Path
from urllib.parse import quote
import unicodedata
import json
import sys

ROOT = Path(__file__).resolve().parent

def encode_web_path(parts):
    # parts: list of path segments relative to project root
    # normalize each segment to NFC then percent-encode so server matches filesystem encoding
    enc_parts = []
    for p in parts:
        if p is None:
            continue
        seg = str(p)
        try:
            seg = unicodedata.normalize('NFC', seg)
        except Exception:
            pass
        enc_parts.append(quote(seg, safe=''))
    return '/' + '/'.join(enc_parts)

def main():
    json_cot_dir = ROOT
    if not json_cot_dir.exists():
        print('json_cot dir not found:', json_cot_dir)
        return

    master = { 'regions': {} }
    region_dirs = sorted([p for p in json_cot_dir.iterdir() if p.is_dir()])
    print(f'Found {len(region_dirs)} region directories: {[p.name for p in region_dirs]}')
    for region_dir in region_dirs:
        try:
            region_code = region_dir.name
            print('Processing region:', region_code)
        except Exception as e:
            print('Skipping region due to error reading name:', region_dir, e)
            continue
        out = { 'region': region_code, 'districts': {} }
        # if region contains subdirs (districts), group by subdir
        has_subdirs = any(x.is_dir() for x in region_dir.iterdir())
        if has_subdirs:
            for d in sorted([p for p in region_dir.iterdir() if p.is_dir()]):
                files = []
                for f in sorted(d.glob('*.json')):
                    rel_parts = ['cot_trung_tuyen', 'json_cot', region_code, d.name, f.name]
                    # display name: remove .json and drop leading province_ prefix if present
                    fname = f.name
                    if fname.lower().endswith('.json'):
                        fname_no_ext = fname[:-5]
                    else:
                        fname_no_ext = fname
                    if '_' in fname_no_ext:
                        display_name = fname_no_ext.split('_', 1)[1]
                    else:
                        display_name = fname_no_ext
                    web_raw = '/' + '/'.join(rel_parts)
                    files.append({ 'name': display_name, 'url': web_raw })
                if files:
                    out['districts'][d.name] = files
        else:
            # group files directly under region dir by prefix before first underscore
            mapping = {}
            for f in sorted(region_dir.glob('*.json')):
                name = f.name
                prefix = name.split('_',1)[0] if '_' in name else name
                rel_parts = ['cot_trung_tuyen', 'json_cot', region_code, f.name]
                # shorten display name as above
                if name.lower().endswith('.json'):
                    name_no_ext = name[:-5]
                else:
                    name_no_ext = name
                display_name = name_no_ext.split('_',1)[1] if '_' in name_no_ext else name_no_ext
                web_raw = '/' + '/'.join(rel_parts)
                mapping.setdefault(prefix, []).append({ 'name': display_name, 'url': web_raw })
            out['districts'] = mapping

        # add to master (we will write a single master index.json)
        master['regions'][region_code] = out['districts']
        print('Collected region', region_code, 'with', len(out['districts']), 'districts')

    # write master index at json_cot root
    master_path = json_cot_dir / 'index.json'
    with master_path.open('w', encoding='utf-8') as mf:
        json.dump(master, mf, ensure_ascii=False, indent=2)
    print('Wrote master index', master_path)

if __name__ == '__main__':
    main()
